import type {
  AgentSession,
  AgentSessionEvent,
  SessionManager,
  SessionMessageEntry
} from '@earendil-works/pi-coding-agent'
import type { ConversationNode } from '../shared/contracts'
import { ConversationProjection } from './conversation-projection'
import { historyGroupId, projectSessionHistory, type HistoryToolOverlay } from './session-history'

type Message = SessionMessageEntry['message']
type Occurrence = { id: string; message: Message; streaming: boolean }
type ToolNode = Extract<ConversationNode, { type: 'tool' }>

function supportsTemporaryHistory(message: Message): boolean {
  const role = message.role
  return role === 'user' || role === 'assistant' || role === 'toolResult'
}

type HistoryTarget = { manager: Pick<SessionManager, 'getSessionId'>; generation: number }
type HistorySession = Pick<AgentSession, 'sessionManager' | 'subscribe'> & {
  agent: Pick<AgentSession['agent'], 'subscribe'>
}

/** Model events carry the actual manager identity, since session IDs can recur A→B→A. */
export class HistoryModelObserver {
  private dirty: (HistoryTarget & { sessionId: string }) | null = null
  constructor(
    private readonly target: () => HistoryTarget | null,
    private readonly schedule: () => void
  ) {}

  observe(readManager: () => HistoryTarget['manager']): void {
    let manager: HistoryTarget['manager']
    // An old extension runner's context getter asserts that it is still active.
    try {
      manager = readManager()
    } catch {
      return
    }
    const target = this.target()
    if (!target || target.manager !== manager) return
    this.dirty = { ...target, sessionId: manager.getSessionId() }
    this.schedule()
  }

  take(): boolean {
    const dirty = this.dirty
    this.dirty = null
    const target = this.target()
    return Boolean(
      dirty &&
      target &&
      dirty.manager === target.manager &&
      dirty.generation === target.generation &&
      dirty.sessionId === target.manager.getSessionId()
    )
  }

  get pending(): boolean {
    return this.dirty !== null
  }
  clear(): void {
    this.dirty = null
  }
}

export class DisplayFailureQuarantine {
  failed = false
  constructor(
    private readonly defer: (callback: () => void) => void,
    private readonly exit: (message: string) => void
  ) {}

  run<T>(callback: () => T): T | undefined {
    if (this.failed) return undefined
    try {
      return callback()
    } catch {
      if (!this.failed) {
        this.failed = true
        this.defer(() => this.exit('会话显示更新失败，请重新连接'))
      }
      return undefined
    }
  }

  assertHealthy(): void {
    if (this.failed) throw new Error('会话显示更新失败，请重新连接')
  }
}

/** Coordinates public preappend events with the later, exact-object core append boundary.
 * Canonical here means appended to the active tree; it does not promise disk durability. */
export class SessionHistoryController {
  private manager: SessionManager | null = null
  private generation = 0
  private sequence = 0
  private objects = new WeakMap<object, Occurrence>()
  private temporary = new Map<string, Occurrence>()
  private active: Occurrence | null = null
  private overlays = new Map<string, HistoryToolOverlay>()
  private currentTools = new Map<string, string>()
  private presentationAliases = new Map<string, string>()
  private unsubscribe: (() => void) | null = null

  constructor(private readonly projection: ConversationProjection) {}

  connect(
    session: HistorySession,
    generation: number,
    callbacks: {
      quarantine: DisplayFailureQuarantine
      onEvent: (event: AgentSessionEvent) => void
      onCommitted: () => void
    }
  ): void {
    this.bind(session.sessionManager, generation)
    const manager = session.sessionManager
    const current = () =>
      this.manager === manager &&
      session.sessionManager === manager &&
      this.generation === generation
    const publicUnsubscribe = session.subscribe((event) => {
      if (!current()) return
      callbacks.quarantine.run(() => {
        if (event.type === 'message_start') this.start(event.message)
        else if (event.type === 'message_end') this.end(event.message)
        callbacks.onEvent(event)
      })
    })
    const coreUnsubscribe = session.agent.subscribe((event) => {
      if (!current() || event.type !== 'message_end') return
      callbacks.quarantine.run(() => {
        this.committed(event.message)
        callbacks.onCommitted()
      })
    })
    this.unsubscribe = () => {
      publicUnsubscribe()
      coreUnsubscribe()
    }
  }

  bind(manager: SessionManager, generation: number): void {
    this.detach()
    this.manager = manager
    this.generation = generation
    this.refresh()
  }

  detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.manager = null
    this.objects = new WeakMap()
    this.temporary.clear()
    this.active = null
    this.overlays.clear()
    this.currentTools.clear()
    this.presentationAliases.clear()
  }

  start(message: Message): void {
    if (!this.manager || !supportsTemporaryHistory(message)) return
    const occurrence = {
      id: `${this.generation}-${++this.sequence}`,
      message,
      streaming: message.role === 'assistant'
    }
    this.active = occurrence
    this.objects.set(message, occurrence)
    this.temporary.set(occurrence.id, occurrence)
    if (message.role === 'assistant' || message.role === 'user') this.currentTools.clear()
    this.projectOccurrence(occurrence)
  }

  update(message: Message, streaming = true): void {
    if (!this.manager) return
    const occurrence =
      this.objects.get(message) ?? (this.active?.message.role === message.role ? this.active : null)
    if (
      !occurrence ||
      !this.temporary.has(occurrence.id) ||
      (streaming && this.active !== occurrence)
    )
      return
    occurrence.message = message
    occurrence.streaming = streaming
    this.objects.set(message, occurrence)
    this.projectOccurrence(occurrence)
  }

  end(message: Message): void {
    if (!supportsTemporaryHistory(message)) return
    // A final object may have belonged to a retired occurrence. The explicit
    // message_end boundary identifies the active lifecycle; late deltas do not.
    if (this.active?.message.role === message.role) this.objects.set(message, this.active)
    this.update(message, false)
    this.active = null
  }

  committed(message: Message): void {
    if (!this.manager) return
    const branch = this.manager.getBranch()
    const entry = branch.findLast((item) => item.type === 'message' && item.message === message)
    const occurrence = this.objects.get(message)
    if (entry && occurrence) {
      const oldPrefix = historyGroupId({ source: 'temporary', id: occurrence.id })
      const newPrefix = historyGroupId({ source: 'entry', id: entry.id })
      // Remap only the known group prefix; the provider's opaque ID suffix is not parsed.
      const previous = new Map(this.projection.view().map((node) => [node.id, node]))
      for (const node of projectSessionHistory([entry])) {
        const displayed = previous.get(oldPrefix + node.id.slice(newPrefix.length))
        if (displayed?.presentationIdentity)
          this.presentationAliases.set(node.id, displayed.presentationIdentity)
      }
      for (const [id, overlay] of this.overlays) {
        if (!id.startsWith(`${oldPrefix}:`)) continue
        this.overlays.delete(id)
        this.overlays.set(newPrefix + id.slice(oldPrefix.length), overlay)
      }
      for (const [callId, id] of this.currentTools) {
        if (id.startsWith(`${oldPrefix}:`))
          this.currentTools.set(callId, newPrefix + id.slice(oldPrefix.length))
      }
      this.temporary.delete(occurrence.id)
    }
    this.reconcile(branch)
  }

  refresh(): void {
    if (this.manager) this.reconcile(this.manager.getBranch())
  }

  updateTool(toolCallId: string, changes: Partial<ToolNode>): void {
    const id = this.currentTools.get(toolCallId)
    if (!id) return
    const previous = this.overlays.get(id) ?? {}
    this.overlays.set(id, { ...previous, ...changes })
    this.projection.update(id, (node) =>
      node.type === 'tool' ? { ...node, ...changes, id } : node
    )
  }

  private reconcile(branch: ReturnType<SessionManager['getBranch']>): void {
    const nodes = projectSessionHistory(branch, {
      temporaryMessages: [...this.temporary.values()],
      toolOverlays: this.overlays
    })
    const activeIds = new Set(nodes.map((node) => node.id))
    for (const id of this.presentationAliases.keys())
      if (!activeIds.has(id)) this.presentationAliases.delete(id)
    this.projection.reconcile(
      nodes.map((node) => {
        const presentationIdentity = this.presentationAliases.get(node.id)
        return presentationIdentity ? { ...node, presentationIdentity } : node
      })
    )
    for (const occurrence of this.temporary.values()) this.trackOccurrence(occurrence)
  }

  private projectOccurrence(occurrence: Occurrence): void {
    const nodes = projectSessionHistory([], {
      temporaryMessages: [occurrence],
      toolOverlays: this.overlays
    })
    this.projection.replaceGroup(historyGroupId({ source: 'temporary', id: occurrence.id }), nodes)
    for (const node of nodes)
      if (node.type === 'tool') this.currentTools.set(node.toolCallId, node.id)
  }

  private trackOccurrence(occurrence: Occurrence): void {
    const group = historyGroupId({ source: 'temporary', id: occurrence.id })
    this.projection.trackGroup(
      group,
      this.projection
        .view()
        .filter((node) => node.id.startsWith(`${group}:`))
        .map((node) => node.id)
    )
  }
}
