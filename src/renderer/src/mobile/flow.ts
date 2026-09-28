import type { ApprovalRequest, ConversationNode } from '../../../shared/contracts'
import { groupConversationWork, type WorkNode } from '../store/conversation-work-groups'
import { summarizeTurnChanges, type TurnFileChange } from '../store/turn-changes'

export type FlowItem =
  | { kind: 'node'; key: string; node: ConversationNode; latest: boolean }
  | { kind: 'work'; key: string; nodes: WorkNode[]; running: boolean }
  | { kind: 'receipt'; key: string; files: TurnFileChange[]; entryId?: string }

/**
 * The phone's reading order: consecutive thinking and tool calls fold into one work group,
 * and each finished turn closes with the files it changed. Keys follow the Host's
 * presentation identities, so streaming updates patch rows in place instead of rebuilding.
 */
export function buildFlow(nodes: readonly ConversationNode[], busy: boolean): FlowItem[] {
  const groups = groupConversationWork(nodes)
  const latestReply = nodes.findLast((node) => node.type === 'assistant')
  const items: FlowItem[] = []
  let turn: ConversationNode[] = []
  let turnKey = 'start'
  let entryId: string | undefined
  const closeTurn = (): void => {
    const files = summarizeTurnChanges(turn)
    if (files.length)
      items.push({
        kind: 'receipt',
        key: `receipt:${turnKey}`,
        files,
        ...(entryId ? { entryId } : {})
      })
    turn = []
  }
  groups.forEach((group, index) => {
    if (group.kind === 'node' && group.node.type === 'user') {
      closeTurn()
      turnKey = group.key
      entryId = group.node.canonicalEntryId
    }
    if (group.kind === 'work') {
      turn.push(...group.nodes)
      items.push({
        kind: 'work',
        key: group.key,
        nodes: group.nodes,
        running: busy && index === groups.length - 1
      })
    } else
      items.push({
        kind: 'node',
        key: group.key,
        node: group.node,
        latest: group.node === latestReply
      })
  })
  if (!busy) closeTurn()
  return items
}

/** Approvals whose tool call is not on screen (e.g. trimmed history) still need a card. */
export function unplacedApprovals(
  nodes: readonly ConversationNode[],
  approvals: readonly ApprovalRequest[]
): ApprovalRequest[] {
  const waiting = new Set(
    nodes.flatMap((node) =>
      node.type === 'tool' && node.status === 'awaiting-approval' ? [node.toolCallId] : []
    )
  )
  return approvals.filter((approval) => !waiting.has(approval.toolCallId))
}

/** Whether the reader is close enough to the end to keep following new output. */
export function nearBottom(
  element: { scrollHeight: number; scrollTop: number; clientHeight: number },
  slack = 72
): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= slack
}
