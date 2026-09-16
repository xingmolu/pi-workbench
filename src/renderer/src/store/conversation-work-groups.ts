import type { ConversationNode } from '../../../shared/contracts'

export type WorkNode = Extract<ConversationNode, { type: 'think' | 'tool' }>
export type ConversationWorkGroup =
  | { kind: 'node'; key: string; node: ConversationNode }
  | { kind: 'work'; key: string; nodes: WorkNode[] }

/** Presentation identities survive the Host's streaming-to-canonical replacement. */
export function groupConversationWork(nodes: readonly ConversationNode[]): ConversationWorkGroup[] {
  const groups: ConversationWorkGroup[] = []
  for (const node of nodes) {
    const key = node.presentationIdentity ?? node.id
    if (node.type === 'think' || node.type === 'tool') {
      const previous = groups.at(-1)
      if (previous?.kind === 'work') previous.nodes.push(node)
      else groups.push({ kind: 'work', key: `work:${key}`, nodes: [node] })
    } else groups.push({ kind: 'node', key, node })
  }
  return groups
}

export function workPresentation(
  nodes: readonly WorkNode[],
  running = false
): {
  label: string
  requiresAttention: boolean
} {
  const requiresAttention = nodes.some(
    (node) =>
      node.type === 'tool' && ['awaiting-approval', 'error', 'blocked'].includes(node.status)
  )
  const active = nodes.findLast((node) => node.type === 'tool' && node.status === 'running')
  const waiting = nodes.findLast(
    (node) => node.type === 'tool' && node.status === 'waiting-resource'
  )
  // Tool durations can overlap; run totals and transcript timestamps are not segment clocks.
  return {
    label: running
      ? !active && waiting?.type === 'tool'
        ? `等待项目资源… · ${waiting.title}`
        : `正在工作…${active?.type === 'tool' ? ` · ${active.title}` : ''}`
      : `工作过程 · ${nodes.length} 项`,
    requiresAttention
  }
}
