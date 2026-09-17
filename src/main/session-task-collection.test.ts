import { describe, expect, it, vi } from 'vitest'
import type {
  BackgroundSessionHandle,
  BackgroundSessionResult,
  BackgroundSessionStatus
} from './background-session-service'
import {
  SessionTaskOrchestrator,
  type SessionTaskParent,
  type SessionTaskRuntime
} from './session-task-orchestrator'

const parent: SessionTaskParent = {
  workerId: 'parent-worker',
  sessionId: 'parent-session',
  generation: 5
}

function fixture() {
  let sequence = 0
  const statuses = new Map<string, BackgroundSessionStatus>()
  const results = new Map<string, BackgroundSessionResult>()
  const runtime: SessionTaskRuntime = {
    spawnFromParent: vi.fn(async () => {
      const index = ++sequence
      const handle: BackgroundSessionHandle = {
        workerId: `worker-${index}`,
        sessionId: `session-${index}`,
        generation: index,
        projectPath: '/project'
      }
      statuses.set(handle.workerId, {
        ...handle,
        status: 'running',
        busy: true,
        queuedCount: 0,
        approvals: 0
      })
      results.set(handle.workerId, { outcome: 'pending' })
      return handle
    }),
    send: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    status: (handle) => {
      const status = statuses.get(handle.workerId)
      if (!status) throw new Error('missing worker')
      return status
    },
    result: (handle) => results.get(handle.workerId) ?? { outcome: 'unavailable' }
  }
  const orchestrator = new SessionTaskOrchestrator(runtime, {
    createTaskId: () => `task-${sequence}`
  })
  return { orchestrator, statuses, results }
}

describe('session task collection', () => {
  it('aggregates ready, pending and attention outcomes from canonical task results', async () => {
    const { orchestrator, statuses, results } = fixture()
    const ready = await orchestrator.spawn(parent, 'ready')
    const pending = await orchestrator.spawn(parent, 'pending')
    const ambiguous = await orchestrator.spawn(parent, 'ambiguous')
    const gone = await orchestrator.spawn(parent, 'gone')

    statuses.set(ready.workerId, { ...statuses.get(ready.workerId)!, status: 'idle', busy: false })
    statuses.set(ambiguous.workerId, {
      ...statuses.get(ambiguous.workerId)!,
      status: 'idle',
      busy: false
    })
    results.set(ready.workerId, { outcome: 'ready', markdown: 'canonical answer' })
    results.set(pending.workerId, { outcome: 'pending' })
    results.set(ambiguous.workerId, { outcome: 'ambiguous' })
    results.set(gone.workerId, { outcome: 'unavailable' })

    expect(orchestrator.collect(parent)).toMatchObject({
      readyTaskIds: [ready.taskId],
      pendingTaskIds: [pending.taskId],
      attentionTaskIds: [ambiguous.taskId, gone.taskId]
    })
  })

  it('returns an empty collection when the parent has no tasks', () => {
    const { orchestrator } = fixture()
    expect(orchestrator.collect(parent)).toEqual({
      items: [],
      readyTaskIds: [],
      pendingTaskIds: [],
      attentionTaskIds: []
    })
  })
})
