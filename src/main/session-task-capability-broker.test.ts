import { describe, expect, it, vi } from 'vitest'
import type { SessionTaskResponse } from '../shared/session-task-capability'
import { SessionTaskCapabilityBroker } from './session-task-capability-broker'

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
  let waitResolve!: (value: unknown) => void
  const orchestrator = {
    spawn: vi.fn(async () => task),
    send: vi.fn(async () => task),
    status: vi.fn(() => task),
    wait: vi.fn(
      (_parent, _taskId, options?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          waitResolve = resolve
          options?.signal?.addEventListener('abort', () => reject(new Error('wait aborted')), {
            once: true
          })
        })
    ),
    result: vi.fn(() => ({ task, result: { outcome: 'pending' as const } })),
    cancel: vi.fn(async () => ({ ...task, state: 'stopped' as const, busy: false })),
    list: vi.fn(() => [task]),
    release: vi.fn(() => undefined)
  }
  const broker = new SessionTaskCapabilityBroker({ orchestrator })
  const replies: SessionTaskResponse[] = []
  const reply = (message: SessionTaskResponse) => replies.push(message)
  return { broker, orchestrator, replies, reply, resolveWait: (value: unknown) => waitResolve(value) }
}

describe('session task capability broker', () => {
  it('binds worker transport plus session identity before spawning', async () => {
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
          action: 'spawn',
          prompt: 'inspect tests'
        },
        reply
      )
    ).toBe(true)
    await flush()

    expect(orchestrator.spawn).toHaveBeenCalledWith(
      { workerId: 'parent-worker', ...parent },
      'inspect tests'
    )
    expect(replies).toEqual([
      expect.objectContaining({ type: 'session-task-response', requestId: 'r1', ok: true })
    ])
  })

  it('rejects stale parent identity before calling the orchestrator', async () => {
    const { broker, orchestrator, replies, reply } = fixture()

    broker.handle(
      'parent-worker',
      parent,
      {
        type: 'session-task-request',
        requestId: 'r1',
        sessionId: 'replacement',
        generation: 4,
        action: 'list'
      },
      reply
    )
    await flush()

    expect(orchestrator.list).not.toHaveBeenCalled()
    expect(replies[0]).toMatchObject({ requestId: 'r1', ok: false })
  })

  it('rejects duplicate in-flight request ids without replacing the original wait', async () => {
    const { broker, replies, reply } = fixture()
    const request = {
      type: 'session-task-request' as const,
      requestId: 'same',
      sessionId: parent.sessionId,
      generation: parent.generation,
      action: 'wait' as const,
      taskId: task.taskId,
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

  it('only cancels a matching wait and clears it when the worker exits', async () => {
    const { broker, orchestrator, replies, reply } = fixture()
    broker.handle(
      'parent-worker',
      parent,
      {
        type: 'session-task-request',
        requestId: 'wait-1',
        sessionId: parent.sessionId,
        generation: parent.generation,
        action: 'wait',
        taskId: task.taskId
      },
      reply
    )
    await flush()

    expect(broker.hasPending('parent-worker')).toBe(true)
    broker.handle('other-worker', parent, { type: 'session-task-cancel', requestId: 'wait-1' }, reply)
    expect(broker.hasPending('parent-worker')).toBe(true)

    broker.workerExited('parent-worker')
    await flush()
    expect(orchestrator.wait).toHaveBeenCalledTimes(1)
    expect(broker.hasPending('parent-worker')).toBe(false)
    expect(replies).toContainEqual(
      expect.objectContaining({ requestId: 'wait-1', ok: false, error: 'wait aborted' })
    )
  })
})
