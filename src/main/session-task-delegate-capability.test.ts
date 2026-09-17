import { describe, expect, it } from 'vitest'
import type { SessionTaskResponse } from '../shared/session-task-capability'
import { SessionTaskCapabilityBroker } from './session-task-capability-broker'
import type { SessionTaskDelegator } from './session-task-delegation'

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

function broker(delegator?: Pick<SessionTaskDelegator, 'delegate'>) {
  return new SessionTaskCapabilityBroker({
    orchestrator: {
      spawn: async () => task,
      send: async () => task,
      status: () => task,
      wait: async () => ({ outcome: 'completed' as const, task }),
      result: () => ({ task, result: { outcome: 'pending' as const } }),
      cancel: async () => task,
      list: () => [task],
      release: () => undefined
    },
    supervisor: {
      supervise: async () => ({
        mode: 'snapshot' as const,
        outcome: 'snapshot' as const,
        tasks: [task],
        settledTaskIds: [],
        pendingTaskIds: [task.taskId]
      })
    },
    ...(delegator ? { delegator } : {})
  })
}

describe('SessionTask delegate capability', () => {
  it('routes a bounded batch through the exact parent authority', async () => {
    const seen: unknown[] = []
    const value = broker({
      delegate: async (parent, prompts) => {
        seen.push({ parent, prompts })
        return {
          items: [{ index: 0, status: 'spawned' as const, task }],
          spawnedTaskIds: [task.taskId],
          failedIndexes: []
        }
      }
    })
    const replies: SessionTaskResponse[] = []

    expect(
      value.handle(
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

    expect(seen).toEqual([
      {
        parent: { workerId: 'parent-worker', ...identity },
        prompts: ['inspect runtime', 'inspect tests']
      }
    ])
    expect(replies).toEqual([
      expect.objectContaining({
        requestId: 'delegate-1',
        ok: true,
        data: expect.objectContaining({ spawnedTaskIds: ['task-1'], failedIndexes: [] })
      })
    ])
  })

  it('fails closed when a legacy adapter has no delegator', async () => {
    const value = broker()
    const replies: SessionTaskResponse[] = []

    value.handle(
      'parent-worker',
      identity,
      {
        type: 'session-task-request',
        requestId: 'delegate-1',
        sessionId: identity.sessionId,
        generation: identity.generation,
        action: 'delegate',
        tasks: ['inspect runtime']
      },
      (reply) => replies.push(reply)
    )
    await flush()

    expect(replies).toEqual([
      expect.objectContaining({
        requestId: 'delegate-1',
        ok: false,
        error: expect.stringContaining('不支持批量委派')
      })
    ])
  })
})
