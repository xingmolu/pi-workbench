import type { ConversationNode } from '../../../shared/contracts'

/** The latest turn only: old approvals or errors cannot mask a new run. */
export function conversationActivity(
  nodes: readonly ConversationNode[],
  busy: boolean,
  approvals: number
): string | null {
  if (!busy || approvals) return null
  const start = nodes.findLastIndex((node) => node.type === 'user')
  const turn = nodes.slice(start + 1)
  if (turn.some((node) => node.type === 'tool' && node.status === 'awaiting-approval')) return null
  const last = turn.at(-1)
  // Active work groups already own their progress indicator.
  if (last?.type === 'think' || last?.type === 'tool') return null
  if (last?.type === 'assistant' && last.streaming) return '正在回复'
  return '正在处理'
}
