import type { AgentSnapshot, DesktopEvent, HostCommand, HostResult } from '../shared/contracts'
import {
  sameSelectedScope,
  type DesktopCommandOrigin,
  type LiveSessionSummary,
  type SelectedSessionScope
} from '../shared/session-runtime'
import type { AgentRuntime } from './agent-runtime'
import {
  SessionWorkerPool,
  type SessionWorker,
  type SessionWorkerFactoryOptions,
  type SessionWorkerPoolOptions
} from './session-worker-pool'

export type SessionWorkerSafety = {
  receipts: 'unknown' | 'pending' | 'settled'
  unsaved: boolean
}

type SupervisorBaseOptions = Omit<SessionWorkerPoolOptions, 'onEvent' | 'runtime'> & {
  publish(event: DesktopEvent): void
  selected(snapshot: AgentSnapshot): void
  receiptsSettled?(workerId: string, snapshot: AgentSnapshot): boolean
  onWorkerEvent?(workerId: string, snapshot: AgentSnapshot | null): void
}

export type SessionWorkerSupervisorOptions = SupervisorBaseOptions &
  (
    | { runtime: AgentRuntime; createWorker?: never }
    | {
        /** @deprecated Production wiring should migrate to AgentRuntime. */
        createWorker(options: SessionWorkerFactoryOptions): Promise<SessionWorker>
        runtime?: never
      }
  )

function resolveRuntime(options: SessionWorkerSupervisorOptions): AgentRuntime {
  if (options.runtime) return options.runtime
  return { createSession: options.createWorker }
}

/**
 * Stable desktop-facing boundary for resident Agent session workers.
 *
 * The pool owns admission, residency and worker request safety. The supervisor
 * owns desktop selection, event projection and the public operations used by
 * Main, mobile surfaces and future orchestrators. New callers should depend on
 * this facade instead of reaching through to SessionWorkerPool directly.
 */
export class SessionWorkerSupervisor {
  /**
   * Transitional escape hatch for existing Main call sites. Do not use from
   * new code; these accesses are migrated to the facade incrementally.
   *
   * @deprecated Use the supervisor methods instead. This property will become
   * private once Main has finished migrating.
   */
  readonly pool: SessionWorkerPool
  private lastForeground: AgentSnapshot | null = null

  constructor(private readonly options: SessionWorkerSupervisorOptions) {
    this.pool = new SessionWorkerPool({
      capacity: options.capacity,
      canonicalize: options.canonicalize,
      runtime: resolveRuntime(options),
      onExit: options.onExit,
      onNeedsSnapshot: options.onNeedsSnapshot,
      onEvent: (workerId, event) => {
        const snapshot = this.pool.getSnapshot(workerId)
        if (snapshot && options.receiptsSettled)
          this.pool.updateSafety(workerId, {
            receipts: options.receiptsSettled(workerId, snapshot) ? 'settled' : 'pending',
            unsaved: !snapshot.activeSessionPath
          })
        const scope = this.pool.selectedScope
        if (scope?.workerId === workerId) {
          if (snapshot) this.lastForeground = { ...snapshot, desktopScope: scope }
          if (event.event === 'snapshot') this.publish(event.data, scope)
          else if (event.event === 'patch')
            options.publish({
              ...event,
              data: { ...event.data, meta: { ...event.data.meta, desktopScope: scope } }
            })
          else options.publish(event)
        }
        this.summaries()
        options.onWorkerEvent?.(workerId, snapshot)
      }
    })
  }

  get selectedScope(): SelectedSessionScope | null {
    return this.pool.selectedScope
  }

  get hasSelection(): boolean {
    return this.pool.selectedScope !== null
  }

  get quiescent(): boolean {
    return this.pool.quiescent
  }

  isSelected(workerId: string): boolean {
    return this.pool.selectedScope?.workerId === workerId
  }

  retainsSelection(scope: SelectedSessionScope | null): boolean {
    return sameSelectedScope(scope, this.pool.selectedScope)
  }

  validateSelected(scope: SelectedSessionScope | null): void {
    this.pool.validateSelected(scope)
  }

  /** Strict resident lookup. Throws after a worker exits or is evicted. */
  getSnapshot(workerId: string): AgentSnapshot | null {
    return this.pool.getSnapshot(workerId)
  }

  /** Safe resident lookup for asynchronous cleanup and mobile projections. */
  tryGetSnapshot(workerId: string): AgentSnapshot | null {
    try {
      return this.pool.getSnapshot(workerId)
    } catch {
      return null
    }
  }

  getLiveSummaries(): LiveSessionSummary[] {
    return this.pool.getLiveSummaries()
  }

  /**
   * Only summaries whose workers are still resident; excludes crash tombstones.
   * Main, mobile surfaces and future orchestrators should use this instead of
   * inferring residency from SessionWorkerPool internals.
   */
  getResidentSummaries(): LiveSessionSummary[] {
    return this.pool
      .getLiveSummaries()
      .filter((summary) => this.tryGetSnapshot(summary.workerId) !== null)
  }

  findLiveSummary(workerId: string): LiveSessionSummary | undefined {
    return this.pool.getLiveSummaries().find((summary) => summary.workerId === workerId)
  }

  findResidentSummary(workerId: string): LiveSessionSummary | undefined {
    if (!this.tryGetSnapshot(workerId)) return undefined
    return this.findLiveSummary(workerId)
  }

  updateSafety(workerId: string, safety: SessionWorkerSafety): void {
    this.pool.updateSafety(workerId, safety)
  }

  shutdown(): Promise<void> {
    return this.pool.shutdown()
  }

  /** Route a command to a resident worker without changing foreground selection. */
  requestWorker(
    workerId: string,
    command: HostCommand,
    expectedIdentity?: { sessionId: string | null; generation: number }
  ): Promise<HostResult> {
    return this.pool.request({ workerId, selectionEpoch: 0 }, command, expectedIdentity)
  }

  capture(origin?: DesktopCommandOrigin): SelectedSessionScope | null {
    const scope = this.pool.selectedScope
    if (origin) {
      this.pool.validateSelected(origin.scope)
      const snapshot = this.pool.getSnapshot(origin.scope.workerId)
      if (
        !snapshot ||
        snapshot.sessionId !== origin.sessionId ||
        snapshot.generation !== origin.generation
      )
        throw new Error('会话已改变，请刷新后重试')
    }
    return scope
  }

  captureNavigation(origin?: DesktopCommandOrigin): SelectedSessionScope | null {
    const previous = this.lastForeground
    if (
      origin &&
      !this.pool.selectedScope &&
      previous?.desktopScope &&
      previous.desktopScope.workerId === origin.scope.workerId &&
      previous.desktopScope.selectionEpoch === origin.scope.selectionEpoch &&
      previous.sessionId === origin.sessionId &&
      previous.generation === origin.generation
    )
      return null
    return this.capture(origin)
  }

  async request(command: HostCommand, origin?: DesktopCommandOrigin): Promise<HostResult> {
    const scope = this.capture(origin)
    if (!scope) throw new Error('请先打开会话')
    const snapshot = this.pool.getSnapshot(scope.workerId)
    const expectedIdentity =
      origin ??
      (snapshot ? { sessionId: snapshot.sessionId, generation: snapshot.generation } : undefined)
    const result = await this.pool.request(
      scope,
      command,
      expectedIdentity && {
        sessionId: expectedIdentity.sessionId,
        generation: expectedIdentity.generation
      }
    )
    if (result.kind === 'snapshot' || result.kind === 'session-fork')
      return { ...result, snapshot: { ...result.snapshot, desktopScope: scope } }
    return result
  }

  async open(
    target: { cwd: string; path?: string },
    expected: SelectedSessionScope | null,
    model?: { providerId: string; modelId: string },
    origin?: DesktopCommandOrigin
  ): Promise<AgentSnapshot> {
    this.captureNavigation(origin)
    const result = await this.pool.open(target, expected, async (worker) => {
      if (!target.path && model) await worker.request({ type: 'model:set', ...model })
      const state = await worker.request({ type: 'state:get' })
      if (state.kind !== 'snapshot') throw new Error('会话状态不可用')
      this.captureNavigation(origin)
      return state.snapshot
    })
    return this.publish(result.snapshot, result.scope)
  }

  select(workerId: string, origin?: DesktopCommandOrigin): AgentSnapshot {
    const expected = this.captureNavigation(origin)
    const snapshot = this.pool.getSnapshot(workerId)
    if (!snapshot) throw new Error('会话尚未就绪')
    const scope = this.pool.select(workerId, expected)
    return this.publish(snapshot, scope)
  }

  private publish(snapshot: AgentSnapshot, scope: SelectedSessionScope): AgentSnapshot {
    const decorated = { ...snapshot, desktopScope: scope }
    this.lastForeground = decorated
    this.options.selected(decorated)
    this.options.publish({ type: 'event', event: 'snapshot', data: decorated })
    this.summaries()
    return decorated
  }

  summaries(): void {
    this.options.publish({ type: 'event', event: 'sessions', data: this.pool.getLiveSummaries() })
  }
}
