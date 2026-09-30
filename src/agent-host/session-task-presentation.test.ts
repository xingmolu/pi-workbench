import { expect, it } from 'vitest'
import { sessionTaskPresentation, sessionTaskResultPresentation } from './session-task-presentation'
import { subagentOperationSchema } from '../shared/subagent'

const task = {
  taskId: 'task',
  parentWorkerId: 'parent',
  parentSessionId: 'parent-session',
  parentGeneration: 1,
  workerId: 'child',
  sessionId: 'child-session',
  generation: 1,
  projectPath: '/project',
  createdAt: 1,
  updatedAt: 1,
  state: 'running',
  busy: true,
  queuedCount: 0,
  approvals: 0
}
it('projects partial delegation failures without confusing launched workers with completed workers', () => {
  const operation = sessionTaskPresentation(
    'session_task',
    { action: 'delegate', tasks: ['Read auth', 'Read config'] },
    'call'
  )
  const projected = sessionTaskResultPresentation(operation, {
    items: [
      { index: 0, status: 'spawned', task },
      { index: 1, status: 'failed', error: 'Worker limit' }
    ],
    spawnedTaskIds: ['task'],
    failedIndexes: [1]
  })
  expect(projected?.children).toMatchObject([
    { id: 'task', title: 'Read auth', state: 'running' },
    { title: 'Read config', state: 'error', output: 'Worker limit' }
  ])
  expect(subagentOperationSchema.safeParse(projected).success).toBe(true)
})
it('uses structured collection details even when raw display output would be truncated', () => {
  const output = 'result '.repeat(4000)
  const projected = sessionTaskResultPresentation(
    { operation: 'collect', children: [] },
    {
      items: [
        {
          task: { ...task, state: 'idle', busy: false },
          result: { outcome: 'ready', markdown: output }
        }
      ],
      readyTaskIds: ['task'],
      pendingTaskIds: [],
      attentionTaskIds: []
    }
  )
  expect(projected?.children[0]).toMatchObject({ state: 'success', output })
})
it('ignores unsupported tools and malformed SDK result details', () => {
  expect(sessionTaskPresentation('read', {}, 'call')).toBeUndefined()
  const operation = sessionTaskPresentation('session_task', { action: 'collect' }, 'call')
  expect(sessionTaskResultPresentation(operation, { items: 'invalid' })).toEqual(operation)
})
