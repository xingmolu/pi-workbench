import { describe, expect, it, vi } from 'vitest'
import type { SessionTaskResponse } from '../shared/session-task-capability'
import { SessionTaskCapabilityBroker } from './session-task-capability-broker'
import type { SessionTaskSuperviseResult } from './session-task-orchestrator'

const parent = { sessionId: 'parent-session', generation: 3 }
const task = {
  taskId: 'task-1',
  parentWorkerId: 'parent-worker',
  parentSessionId: parent.sessionId,
  parentGeneration: parent.generation,
  workerId: 'child-worker',
  sessionId: 'child-session',
  generation: 8,
  projectPath: '/project',
  createdAt: 1,
  updatedAt: 2,
  state: 'running' as const,
  busy: true,
  queuedCount: 0,
  approvals: 0
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

function fixture() {
  const orchestrator = {
    delegate: vi.fn(async () => ({
      items: [{ index: 0, status: 'spawned' as const, task }],
      spawnedTaskIds: [task.taskId],
      failedIndexes: []
    })),
    send: vi.fn(async () => task),
    supervise: vi.fn(
      (
        _parent,
        options?: { mode?: 'snapshot' | 'any' | 'all'; signal?: AbortSignal }
      ): Promise<SessionTaskSuperviseResult> =>
        new Promise<SessionTaskSuperviseResult>((resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('supervise aborted')), {
            once: true
          })
          if (options?.mode === 'snapshot') {
            resolve({
              mode: 'snapshot',
              outcome: 'snapshot',
              tasks: [task],
              settledTaskIds: [],
              pendingTaskIds: [task.taskId]
            })
          }
        })
    ),
    collect: vi.fn(() => ({
      items: [{ task, result: { outcome: 'pending' as const } }],
      readyTaskIds: [],
      pendingTaskIds: [task.taskId],
      attentionTaskIds: []
    })),
    cancel: vi.fn(async () => ({ ...task, state: 'stopped' as const, busy: false })),
    release: vi.fn(() => undefined)
  }
  const broker = new SessionTaskCapabilityBroker(orchestrator)
  const replies: SessionTaskResponse[] = []
  const reply = (message: SessionTaskResponse) => replies.push(message)
  return { broker, orchestrator, replies, reply }
}

describe('session task capability broker', () => {
  it('binds worker transport plus session identity before delegation', async () => {
    const { broker, orchestrator, replies, reply } = fixture()

    expect(
      broker.handle(
        'parent-worker',
        parent,
        {
          type: 'session-task-request',
          requestId: 'r1',
          sessionId: parent.sessionId,
          generation: parent.generation,
          action: 'delegate',
          tasks: ['inspect tests']
        },
        reply
      )
    ).toBe(true)
    await flush()

    expect(orchestrator.delegate).toHaveBeenCalledWith(
      { workerId: 'parent-worker', ...parent },
      ['inspect tests']
    )
    expect(replies).toEqual([
      expect.objectContaining({ type: 'session-task-response', requestId: 'r1', ok: true })
    ])
  })

  it('rejects stale parent identity before calling the runtime', async () => {
    const { broker, orchestrator, replies, reply } = fixture()

    broker.handle(
      'parent-worker',
      parent,
      {
        type: 'session-task-request',
        requestId: 'r1',
        sessionId: 'replacement',
        generation: 4,
        action: 'collect'
      },
      reply
    )
    await flush()

    expect(orchestrator.collect).not.toHaveBeenCalled()
    expect(replies[0]).toMatchObject({ requestId: 'r1', ok: false })
  })

  it('rejects duplicate in-flight request ids without replacing supervision', async () => {
    const { broker, replies, reply } = fixture()
    const request = {
      type: 'session-task-request' as const,
      requestId: 'same',
      sessionId: parent.sessionId,
      generation: parent.generation,
      action: 'supervise' as const,
      mode: 'all' as const,
      timeoutMs: 1000
    }

    broker.handle('parent-worker', parent, request, reply)
    broker.handle('parent-worker', parent, request, reply)
    await flush()

    expect(replies).toContainEqual(
      expect.objectContaining({ requestId: 'same', ok: false, error: expect.stringContaining('重复') })
    )
    expect(broker.hasPending('parent-worker')).toBe(true)
  })

  it('only cancels matching supervision and clears pending work when the worker exits', async () => {
    const { broker, orchestrator, replies, reply } = fixture()
    broker.handle(
      'parent-worker',
      parent,
      {
        type: 'session-task-request',
        requestId: 'supervise-1',
        sessionId: parent.sessionId,
        generation: parent.generation,
        action: 'supervise',
        mode: 'any'
      },
      reply
    )
    await flush()

    expect(broker.hasPending('parent-worker')).toBe(true)
    broker.handle(
      'other-worker',
      parent,
      { type: 'session-task-cancel', requestId: 'supervise-1' },
      reply
    )
    expect(broker.hasPending('parent-worker')).toBe(true)

    broker.workerExited('parent-worker')
    await flush()
    expect(orchestrator.supervise).toHaveBeenCalledTimes(1)
    expect(broker.hasPending('parent-worker')).toBe(false)
    expect(replies).toContainEqual(
      expect.objectContaining({
        requestId: 'supervise-1',
        ok: false,
        error: 'supervise aborted'
      })
    )
  })

  it('routes supervise through the parent authority and supports explicit cancellation', async () => {
    const { broker, orchestrator, replies, reply } = fixture()

    broker.handle(
      'parent-worker',
      parent,
      {
        type: 'session-task-request',
        requestId: 'supervise-1',
        sessionId: parent.sessionId,
        generation: parent.generation,
        action: 'supervise',
        mode: 'any',
        timeoutMs: 500
      },
      reply
    )
    await flush()

    expect(orchestrator.supervise).toHaveBeenCalledWith(
      { workerId: 'parent-worker', ...parent },
      expect.objectContaining({ mode: 'any', timeoutMs: 500, signal: expect.any(AbortSignal) })
    )
    expect(broker.hasPending('parent-worker')).toBe(true)

    broker.handle(
      'parent-worker',
      parent,
      { type: 'session-task-cancel', requestId: 'supervise-1' },
      reply
    )
    await flush()

    expect(broker.hasPending('parent-worker')).toBe(false)
    expect(replies).toContainEqual(
      expect.objectContaining({
        requestId: 'supervise-1',
        ok: false,
        error: 'supervise aborted'
      })
    )
  })
})
