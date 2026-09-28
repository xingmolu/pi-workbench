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
  const awaitingApproval = nodes.some((node) => node.type === 'tool' && node.status === 'awaiting-approval')
  // Tool durations can overlap; run totals and transcript timestamps are not segment clocks.
  return {
    label: awaitingApproval
      ? '已暂停 · 等待确认'
      : running
      ? !active && waiting?.type === 'tool'
        ? `等待项目资源… · ${waiting.title}`
        : `正在工作…${active?.type === 'tool' ? ` · ${active.title}` : ''}`
      : `工作过程 · ${nodes.length} 项`,
    requiresAttention
  }
}

const DIGEST_ORDER = ['读取', '搜索', '编辑', '命令', '网页', '桌面', '工具'] as const
type DigestKind = (typeof DIGEST_ORDER)[number]

function digestKind(node: Extract<WorkNode, { type: 'tool' }>): DigestKind {
  if (node.change || node.intent === 'diff') return '编辑'
  switch (node.intent) {
    case 'read':
      return '读取'
    case 'search':
      return '搜索'
    case 'terminal':
      return '命令'
    case 'web':
      return '网页'
    case 'desktop':
      return '桌面'
    default:
      return '工具'
  }
}

/** What a settled work group did, e.g. "读取 1 · 编辑 2 · 命令 1", plus how many calls failed. */
export function workDigest(nodes: readonly WorkNode[]): {
  parts: { label: DigestKind; count: number }[]
  failed: number
} {
  const counts = new Map<DigestKind, number>()
  let failed = 0
  for (const node of nodes) {
    if (node.type !== 'tool') continue
    const kind = digestKind(node)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
    if (node.status === 'error' || node.status === 'blocked') failed += 1
  }
  return {
    parts: DIGEST_ORDER.filter((kind) => counts.has(kind)).map((label) => ({
      label,
      count: counts.get(label)!
    })),
    failed
  }
}
