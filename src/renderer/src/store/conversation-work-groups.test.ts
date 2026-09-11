import { expect, it } from 'vitest'
import type { ConversationNode } from '../../../shared/contracts'
import { groupConversationWork, workPresentation, type WorkNode } from './conversation-work-groups'

it('groups consecutive work without hiding answers or crossing conversation boundaries', () => {
  const nodes: ConversationNode[] = [
    { id: 'think', type: 'think', text: 'reason' },
    { id: 'answer', type: 'assistant', markdown: 'answer' },
    { id: 'next', type: 'think', text: 'next reason' }
  ]
  const groups = groupConversationWork(nodes)
  expect(groups.map((item) => item.kind)).toEqual(['work', 'node', 'work'])
  expect(groups[1]).toMatchObject({ node: nodes[1] })
})

const tool = (
  id: string,
  status: 'success' | 'running' | 'error' | 'blocked' | 'awaiting-approval' = 'success'
): Extract<WorkNode, { type: 'tool' }> => ({
  id,
  type: 'tool',
  toolCallId: 'reused',
  name: 'bash',
  intent: 'terminal',
  title: '运行命令',
  status,
  durationMs: 9000
})

it('retains distinct repeated tool occurrences and the live group identity after canonical replacement', () => {
  const live: WorkNode = {
    id: 'temporary',
    presentationIdentity: 'stable',
    type: 'think',
    text: 'a',
    streaming: true
  }
  const before = groupConversationWork([live, tool('first')])
  const after = groupConversationWork([
    { ...live, id: 'canonical', streaming: false },
    tool('first'),
    tool('second')
  ])
  expect(before[0].key).toBe(after[0].key)
  expect(after[0]).toMatchObject({
    nodes: [{ id: 'canonical' }, { id: 'first' }, { id: 'second' }]
  })
})

it.each(['error', 'blocked', 'awaiting-approval'] as const)('keeps %s work visible', (status) => {
  expect(workPresentation([tool('one', status)]).requiresAttention).toBe(true)
})

it('never presents overlapping tool durations or missing measurements as segment seconds', () => {
  expect(workPresentation([tool('one'), tool('two')])).toEqual({
    label: '工作过程 · 2 项',
    requiresAttention: false
  })
  expect(workPresentation([tool('one', 'running')], true).label).toBe('正在工作… · 运行命令')
})

it('does not label historical unfinished tool calls or stopped thinking as currently running', () => {
  expect(workPresentation([tool('old', 'running')]).label).toBe('工作过程 · 1 项')
  expect(
    workPresentation([{ id: 'old-think', type: 'think', text: 'old', streaming: true }]).label
  ).toBe('工作过程 · 1 项')
})

it('names the running tool ahead of later queued tools', () => {
  const active: WorkNode = { ...tool('active', 'running'), title: '读取 A' }
  const queued: WorkNode = { ...tool('queued'), status: 'queued', title: '读取 B' }
  expect(workPresentation([active, queued], true).label).toBe('正在工作… · 读取 A')
})

it('keeps queued-only work generic and historical queued work inactive', () => {
  const queued: WorkNode = { ...tool('queued'), status: 'queued', title: '读取 B' }
  expect(workPresentation([queued], true).label).toBe('正在工作…')
  expect(workPresentation([queued]).label).toBe('工作过程 · 1 项')
})

it('preserves model, compaction, user, stop and error boundaries in order', () => {
  const boundaries: ConversationNode[] = [
    { id: 'u', type: 'user', text: 'question' },
    { id: 'm', type: 'model', modelId: 'm', provider: 'p', initial: false },
    { id: 'c', type: 'compaction', tokensBefore: 100 },
    { id: 's', type: 'stopped', message: 'stopped' },
    { id: 'e', type: 'error', message: 'error' }
  ]
  expect(
    groupConversationWork(boundaries.flatMap((node, i) => [tool(`tool${i}`), node])).map(
      (item) => item.key
    )
  ).toEqual([
    'work:tool0',
    'u',
    'work:tool1',
    'm',
    'work:tool2',
    'c',
    'work:tool3',
    's',
    'work:tool4',
    'e'
  ])
})
