import { describe, expect, it, vi } from 'vitest'
import type { SessionTaskResponse } from '../shared/session-task-capability'
import { SessionTaskCapabilityBroker } from './session-task-capability-broker'

const identity = { sessionId: 'parent-session', generation: 3 }
const task = {
  taskId: 'task-1',
  parentWorkerId: 'parent-worker',
  parentSessionId: identity.sessionId,
  parentGeneration: identity.generation,
  workerId: 'child-worker',
  sessionId: 'child-session',
  generation: 1,
  projectPath: '/project',
  createdAt: 1,
  updatedAt: 2,
  state: 'running' as const,
  busy: true,
  queuedCount: 0,
  approvals: 0
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

function runtime() {
  return {
    spawn: vi.fn(async () => task),
    delegate: vi.fn(async () => ({
      items: [{ index: 0, status: 'spawned' as const, task }],
      spawnedTaskIds: [task.taskId],
      failedIndexes: []
    })),
    send: vi.fn(async () => task),
    status: vi.fn(() => task),
    wait: vi.fn(async () => ({ outcome: 'completed' as const, task })),
    supervise: vi.fn(async () => ({
      mode: 'snapshot' as const,
      outcome: 'snapshot' as const,
      tasks: [task],
      settledTaskIds: [],
      pendingTaskIds: [task.taskId]
    })),
    result: vi.fn(() => ({ task, result: { outcome: 'pending' as const } })),
    collect: vi.fn(() => ({
      items: [{ task, result: { outcome: 'pending' as const } }],
      readyTaskIds: [],
      pendingTaskIds: [task.taskId],
      attentionTaskIds: []
    })),
    cancel: vi.fn(async () => task),
    list: vi.fn(() => [task]),
    release: vi.fn(() => undefined)
  }
}

describe('SessionTask delegate capability', () => {
  it('routes a bounded batch through the exact parent authority', async () => {
    const orchestrator = runtime()
    const broker = new SessionTaskCapabilityBroker(orchestrator)
    const replies: SessionTaskResponse[] = []

    expect(
      broker.handle(
        'parent-worker',
        identity,
        {
          type: 'session-task-request',
          requestId: 'delegate-1',
          sessionId: identity.sessionId,
          generation: identity.generation,
          action: 'delegate',
          tasks: ['inspect runtime', 'inspect tests']
        },
        (reply) => replies.push(reply)
      )
    ).toBe(true)
    await flush()

    expect(orchestrator.delegate).toHaveBeenCalledWith(
      { workerId: 'parent-worker', ...identity },
      ['inspect runtime', 'inspect tests']
    )
    expect(replies).toEqual([
      expect.objectContaining({
        requestId: 'delegate-1',
        ok: true,
        data: expect.objectContaining({ spawnedTaskIds: ['task-1'], failedIndexes: [] })
      })
    ])
  })
})
