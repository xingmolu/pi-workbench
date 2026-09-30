import { expect, it } from 'vitest'
import { EMPTY_SNAPSHOT } from '../renderer/src/store/pi-store'
import { subagentProgress } from './subagent-progress'

it('does not treat prior replies as the current task result and bounds previews', () => {
  const snapshot = {
    ...EMPTY_SNAPSHOT,
    status: 'running' as const,
    busy: true,
    nodes: [
      { type: 'assistant' as const, id: 'old', markdown: 'OLD', canonicalEntryId: 'old' },
      { type: 'user' as const, id: 'followup', text: 'Follow up' },
      { type: 'assistant' as const, id: 'current', markdown: 'x'.repeat(4000), streaming: true },
      ...Array.from({ length: 10 }, (_, index) => ({
        type: 'tool' as const,
        id: `tool${index}`,
        toolCallId: `${index}`,
        name: 'read',
        title: `Read ${index}`,
        intent: 'read' as const,
        status: 'success' as const
      }))
    ]
  }
  const preview = subagentProgress('task', snapshot, 10)
  expect(preview.state).toBe('running')
  expect(preview.output).toHaveLength(1200)
  expect(preview.truncated).toBe(true)
  expect(preview.activity).toBe('Read 9')
  expect(preview.recentTools).toHaveLength(3)
})
it('requires a final canonical reply before reporting success', () => {
  const snapshot = {
    ...EMPTY_SNAPSHOT,
    nodes: [{ type: 'assistant' as const, id: 'a', markdown: 'done' }]
  }
  expect(subagentProgress('task', snapshot, 10).state).toBe('idle')
  expect(
    subagentProgress(
      'task',
      { ...snapshot, nodes: [{ ...snapshot.nodes[0], canonicalEntryId: 'entry' }] },
      10
    ).state
  ).toBe('success')
})
