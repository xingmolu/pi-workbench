import { expect, it } from 'vitest'
import type { ApprovalRequest, ConversationNode, ToolFileChange } from '../../../shared/contracts'
import { buildFlow, nearBottom, unplacedApprovals } from './flow'

const change: ToolFileChange = {
  path: '/p/a.ts',
  kind: 'edit',
  source: 'applied',
  anchored: true,
  patch: '',
  additions: 2,
  deletions: 1
}
const tool = (
  id: string,
  status: 'success' | 'awaiting-approval' | 'running' = 'success'
): ConversationNode => ({
  id,
  type: 'tool',
  toolCallId: `call-${id}`,
  name: 'edit',
  intent: 'diff',
  title: id,
  status,
  change
})
const nodes: ConversationNode[] = [
  { id: 'u1', type: 'user', text: 'one' },
  { id: 'k1', type: 'think', text: 'hm' },
  tool('t1'),
  { id: 'a1', type: 'assistant', markdown: 'done' },
  { id: 'u2', type: 'user', text: 'two' },
  tool('t2', 'running')
]

it('folds work into groups and closes each finished turn with its file changes', () => {
  const flow = buildFlow(nodes, true)
  expect(flow.map((item) => item.kind)).toEqual(['node', 'work', 'node', 'receipt', 'node', 'work'])
  const work = flow.filter((item) => item.kind === 'work')
  expect(work.map((item) => item.running)).toEqual([false, true])
  // The running turn gets no receipt until it settles.
  expect(buildFlow([...nodes.slice(0, -1), tool('t2')], false).at(-1)).toMatchObject({
    kind: 'receipt'
  })
  expect(flow.find((item) => item.kind === 'node' && item.node.id === 'a1')).toMatchObject({
    latest: true
  })
})

it('keeps keys stable across a streaming update so rows patch in place', () => {
  const before = buildFlow(nodes, true).map((item) => item.key)
  const after = buildFlow([...nodes.slice(0, -1), tool('t2')], true).map((item) => item.key)
  expect(after).toEqual(before)
})

it('places approvals on their tool rows and keeps the rest visible', () => {
  const approval = (toolCallId: string): ApprovalRequest => ({
    id: toolCallId,
    generation: 1,
    toolCallId,
    toolName: 'edit',
    intent: 'diff' as const,
    title: 't',
    detail: '{}'
  })
  const waiting = [...nodes, tool('t3', 'awaiting-approval')]
  expect(
    unplacedApprovals(waiting, [approval('call-t3'), approval('elsewhere')]).map((a) => a.id)
  ).toEqual(['elsewhere'])
})

it('follows only a reader who is at the end', () => {
  expect(nearBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 400 })).toBe(true)
  expect(nearBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 400 })).toBe(false)
})
