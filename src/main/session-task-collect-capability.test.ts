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
  state: 'idle' as const,
  busy: false,
  queuedCount: 0,
  approvals: 0
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

function runtime() {
  return {
    spawn: vi.fn(async () => task),
    delegate: vi.fn(async () => ({ items: [], spawnedTaskIds: [], failedIndexes: [] })),
    send: vi.fn(async () => task),
    status: vi.fn(() => task),
    wait: vi.fn(async () => ({ outcome: 'completed' as const, task })),
    supervise: vi.fn(async () => ({
      mode: 'snapshot' as const,
      outcome: 'snapshot' as const,
      tasks: [task],
      settledTaskIds: [task.taskId],
      pendingTaskIds: []
    })),
    result: vi.fn(() => ({ task, result: { outcome: 'ready' as const, markdown: 'answer' } })),
    collect: vi.fn(() => ({
      items: [{ task, result: { outcome: 'ready' as const, markdown: 'answer' } }],
      readyTaskIds: [task.taskId],
      pendingTaskIds: [],
      attentionTaskIds: []
    })),
    cancel: vi.fn(async () => task),
    list: vi.fn(() => [task]),
    release: vi.fn(() => undefined)
  }
}

describe('SessionTask collect capability', () => {
  it('routes a collect read through the exact parent authority', async () => {
    const orchestrator = runtime()
    const broker = new SessionTaskCapabilityBroker(orchestrator)
    const replies: SessionTaskResponse[] = []

    expect(
      broker.handle(
        'parent-worker',
        identity,
        {
          type: 'session-task-request',
          requestId: 'collect-1',
          sessionId: identity.sessionId,
          generation: identity.generation,
          action: 'collect'
        },
        (reply) => replies.push(reply)
      )
    ).toBe(true)
    await flush()

    expect(orchestrator.collect).toHaveBeenCalledWith({ workerId: 'parent-worker', ...identity })
    expect(replies).toEqual([
      expect.objectContaining({
        requestId: 'collect-1',
        ok: true,
        data: expect.objectContaining({ readyTaskIds: ['task-1'] })
      })
    ])
  })
})
