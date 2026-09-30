import { sessionTaskPresentation, sessionTaskResultPresentation } from './session-task-presentation'
import type { SessionEntry, SessionMessageEntry } from '@earendil-works/pi-coding-agent'
import type { ConversationNode, ToolStatus } from '../shared/contracts'
import { assistantTerminalNode } from './assistant-outcome'
import { textFromContent, toolIntent, toolPresentation } from './message-presentation'
import { appliedToolChange, proposedToolChange } from './tool-change'
import { MESSAGE_FEEDBACK_TYPE, messageFeedbackDataSchema, type MessageFeedbackValue } from '../shared/message-actions'

type ToolNode = Extract<ConversationNode, { type: 'tool' }>
export type HistoryMessageIdentity = { source: 'entry' | 'temporary'; id: string }
export type HistoryToolOverlay = {
  status?: ToolStatus
  output?: string
  originalOutputLength?: number
  truncated?: boolean
  durationMs?: number
  change?: ToolNode['change']
  subagent?: ToolNode['subagent']
}
export type SessionHistoryOptions = {
  /** Caller supplies stable, generation-scoped identities only for messages not yet appended. */
  temporaryMessages?: readonly {
    id: string
    message: SessionMessageEntry['message']
    streaming?: boolean
  }[]
  /** Exact occurrence node IDs, never provider tool IDs. Caller selects current-run overlays. */
  toolOverlays?: ReadonlyMap<string, HistoryToolOverlay>
}

function identityPart(value: string): string {
  try {
    return encodeURIComponent(value)
  } catch {
    // JSON permits lone UTF-16 surrogates. Preserve every code unit; this prefix cannot
    // occur in normal URI encoding, so malformed and ordinary strings cannot collide.
    return `%utf16-${value
      .split('')
      .map((unit) => unit.charCodeAt(0).toString(16).padStart(4, '0'))
      .join('')}`
  }
}

export function historyGroupId(identity: HistoryMessageIdentity): string {
  return `${identity.source}:${identityPart(identity.id)}`
}

export function historyNodeId(
  identity: HistoryMessageIdentity,
  kind: ConversationNode['type'],
  blockIndex?: number,
  toolCallId?: string
): string {
  return `${historyGroupId(identity)}:${kind}${blockIndex === undefined ? '' : `:${blockIndex}`}${toolCallId === undefined ? '' : `:${identityPart(toolCallId)}`}`
}

function nodeIdentity(
  identity: HistoryMessageIdentity,
  kind: ConversationNode['type'],
  blockIndex?: number,
  toolCallId?: string
): Pick<ConversationNode, 'id' | 'presentationIdentity'> {
  return {
    id: historyNodeId(identity, kind, blockIndex, toolCallId),
    ...(identity.source === 'temporary'
      ? { presentationIdentity: `presentation:${identity.id}:${kind}:${blockIndex ?? 'message'}` }
      : {})
  }
}

function outputFields(
  output: string
): Pick<ToolNode, 'output' | 'originalOutputLength' | 'truncated'> {
  return {
    output: output.slice(0, 12000),
    originalOutputLength: output.length,
    truncated: output.length > 12000
  }
}

/** Display the canonical active path, not the compacted model context. Unsupported custom,
 * branch-summary and administrative entries are intentionally omitted, never reinterpreted
 * as human/assistant messages. This function performs no IO and does not modify the tree. */
export function projectSessionHistory(
  activeBranch: readonly SessionEntry[],
  options: SessionHistoryOptions = {}
): ConversationNode[] {
  const nodes: ConversationNode[] = []
  const pending = new Map<string, ToolNode[]>()
  let hasModel = false
  const feedback = new Map<string, MessageFeedbackValue>()
  for (const entry of activeBranch) {
    if (entry.type !== 'custom' || entry.customType !== MESSAGE_FEEDBACK_TYPE) continue
    const parsed = messageFeedbackDataSchema.safeParse(entry.data)
    if (parsed.success) feedback.set(parsed.data.entryId, parsed.data.value)
  }

  const projectMessage = (
    message: SessionMessageEntry['message'],
    identity: HistoryMessageIdentity,
    streaming = false
  ): void => {
    if (message.role === 'user') {
      pending.clear()
      const text = textFromContent(message.content)
      const imageCount = Array.isArray(message.content)
        ? message.content.filter((block) => block?.type === 'image').length
        : 0
      if (text || imageCount)
        nodes.push({
          ...nodeIdentity(identity, 'user'),
          type: 'user',
          text,
          ...(identity.source === 'entry' ? { canonicalEntryId: identity.id } : {}),
          ...(imageCount ? { imageCount } : {})
        })
      return
    }
    if (message.role === 'toolResult') {
      const queue = pending.get(message.toolCallId)
      const tool = queue?.shift()
      if (tool) {
        Object.assign(tool, outputFields(textFromContent(message.content)), {
          status: message.isError ? 'error' : 'success'
        })
        const subagent = sessionTaskResultPresentation(tool.subagent, message.details)
        if (subagent) tool.subagent = subagent
        const applied = message.isError
          ? undefined
          : appliedToolChange(tool.name, message.details, tool.change?.path)
        if (applied) tool.change = applied
      }
      return
    }
    if (message.role !== 'assistant') return
    // A later assistant turn starts fresh occurrences, including reused provider IDs.
    // Incomplete calls from an earlier stopped turn must not consume a later result.
    pending.clear()
    if (Array.isArray(message.content))
      message.content.forEach((block, index) => {
        if (!block || typeof block !== 'object') return
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          nodes.push({
            ...nodeIdentity(identity, 'assistant', index),
            type: 'assistant',
            markdown: block.text,
            ...(identity.source === 'entry' && !streaming &&
              (message.stopReason === 'stop' || message.stopReason === 'length') &&
              !message.content.some(b => b.type === 'toolCall')
              ? { canonicalEntryId: identity.id, feedback: feedback.get(identity.id) ?? null }
              : {}),
            streaming
          })
        } else if (
          block.type === 'thinking' &&
          typeof block.thinking === 'string' &&
          block.thinking
        ) {
          nodes.push({
            ...nodeIdentity(identity, 'think', index),
            type: 'think',
            text: block.thinking,
            streaming
          })
        } else if (
          block.type === 'toolCall' &&
          typeof block.id === 'string' &&
          typeof block.name === 'string'
        ) {
          const tool: ToolNode = {
            ...nodeIdentity(identity, 'tool', index, block.id),
            type: 'tool',
            toolCallId: block.id,
            name: block.name,
            intent: toolIntent(block.name),
            ...toolPresentation(block.name, block.arguments),
            status: 'queued'
          }
          const subagent = sessionTaskPresentation(block.name, block.arguments, block.id)
          if (subagent) tool.subagent = subagent
          const change = proposedToolChange(block.name, block.arguments)
          if (change) tool.change = change
          nodes.push(tool)
          const queue = pending.get(block.id) ?? []
          queue.push(tool)
          pending.set(block.id, queue)
        }
      })
    const outcome = assistantTerminalNode(message)
    if (outcome) nodes.push({ ...outcome, ...nodeIdentity(identity, outcome.type) })
  }

  for (const entry of activeBranch) {
    const identity: HistoryMessageIdentity = { source: 'entry', id: entry.id }
    if (entry.type === 'message') projectMessage(entry.message, identity)
    else if (entry.type === 'model_change') {
      nodes.push({
        id: historyNodeId(identity, 'model'),
        type: 'model',
        provider: entry.provider,
        modelId: entry.modelId,
        initial: !hasModel
      })
      hasModel = true
    } else if (entry.type === 'compaction') {
      nodes.push({
        id: historyNodeId(identity, 'compaction'),
        type: 'compaction',
        tokensBefore: entry.tokensBefore
      })
    }
  }
  for (const temporary of options.temporaryMessages ?? []) {
    projectMessage(
      temporary.message,
      { source: 'temporary', id: temporary.id },
      temporary.streaming
    )
  }
  return nodes.map((node) => {
    if (node.type !== 'tool') return node
    const overlay = options.toolOverlays?.get(node.id)
    if (!overlay) return node
    return {
      ...node,
      ...(overlay.status !== undefined ? { status: overlay.status } : {}),
      ...(overlay.output !== undefined ? outputFields(overlay.output) : {}),
      ...(overlay.originalOutputLength !== undefined
        ? { originalOutputLength: overlay.originalOutputLength }
        : {}),
      ...(overlay.truncated !== undefined ? { truncated: overlay.truncated } : {}),
      ...(overlay.subagent ? { subagent: overlay.subagent } : {}),
      ...(overlay.durationMs !== undefined ? { durationMs: overlay.durationMs } : {}),
      ...(overlay.change !== undefined && node.change?.source !== 'applied'
        ? { change: overlay.change }
        : {})
    }
  })
}
