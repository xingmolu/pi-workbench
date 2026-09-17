import { describe, expect, it } from 'vitest'
import type { SessionTaskResponse } from '../shared/session-task-capability'
import { SessionTaskCapabilityBroker } from './session-task-capability-broker'
import type { SessionTaskCollector } from './session-task-collection'

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

function broker(collector?: Pick<SessionTaskCollector, 'collect'>) {
  return new SessionTaskCapabilityBroker({
    orchestrator: {
      spawn: async () => task,
      send: async () => task,
      status: () => task,
      wait: async () => ({ outcome: 'completed' as const, task }),
      result: () => ({ task, result: { outcome: 'ready' as const, markdown: 'answer' } }),
      cancel: async () => task,
      list: () => [task],
      release: () => undefined
    },
    supervisor: {
      supervise: async () => ({
        mode: 'snapshot' as const,
        outcome: 'snapshot' as const,
        tasks: [task],
        settledTaskIds: [task.taskId],
        pendingTaskIds: []
      })
    },
    ...(collector ? { collector } : {})
  })
}

describe('SessionTask collect capability', () => {
  it('routes a collect read through the exact parent authority', async () => {
    const seen: unknown[] = []
    const value = broker({
      collect: (parent) => {
        seen.push(parent)
        return {
          items: [{ task, result: { outcome: 'ready', markdown: 'answer' } }],
          readyTaskIds: [task.taskId],
          pendingTaskIds: [],
          attentionTaskIds: []
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
          requestId: 'collect-1',
          sessionId: identity.sessionId,
          generation: identity.generation,
          action: 'collect'
        },
        (reply) => replies.push(reply)
      )
    ).toBe(true)
    await flush()

    expect(seen).toEqual([{ workerId: 'parent-worker', ...identity }])
    expect(replies).toEqual([
      expect.objectContaining({
        requestId: 'collect-1',
        ok: true,
        data: expect.objectContaining({ readyTaskIds: ['task-1'] })
      })
    ])
  })

  it('fails closed when a legacy adapter has no collector', async () => {
    const value = broker()
    const replies: SessionTaskResponse[] = []

    value.handle(
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
    await flush()

    expect(replies).toEqual([
      expect.objectContaining({
        requestId: 'collect-1',
        ok: false,
        error: expect.stringContaining('不支持 canonical 结果聚合')
      })
    ])
  })
})
