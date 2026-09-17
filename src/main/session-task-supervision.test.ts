import { describe, expect, it, vi } from 'vitest'
import type {
  SessionTaskParent,
  SessionTaskView,
  SessionTaskWaitOptions,
  SessionTaskWaitResult
} from './session-task-orchestrator'
import {
  SessionTaskSupervisor,
  type SessionTaskSupervisionRuntime
} from './session-task-supervision'

const parent: SessionTaskParent = {
  workerId: 'parent-worker',
  sessionId: 'parent-session',
  generation: 7
}

function task(
  taskId: string,
  overrides: Partial<SessionTaskView> = {}
): SessionTaskView {
  return {
    taskId,
    parentWorkerId: parent.workerId,
    parentSessionId: parent.sessionId,
    parentGeneration: parent.generation,
    workerId: `worker-${taskId}`,
    sessionId: `session-${taskId}`,
    generation: 1,
    projectPath: '/project',
    createdAt: 1,
    updatedAt: 1,
    state: 'running',
    busy: true,
    queuedCount: 0,
    approvals: 0,
    ...overrides
  }
}

function fixture(initial: SessionTaskView[]) {
  const tasks = new Map(initial.map((value) => [value.taskId, value]))
  const waiters = new Map<
    string,
    Array<{
      resolve(value: SessionTaskWaitResult): void
      reject(error: Error): void
      signal?: AbortSignal
    }>
  >()
  const wait = vi.fn(
    (
      owner: SessionTaskParent,
      taskId: string,
      options: SessionTaskWaitOptions = {}
    ) =>
      new Promise<SessionTaskWaitResult>((resolve, reject) => {
        expect(owner).toEqual(parent)
        const signal = options.signal
        if (signal?.aborted) {
          reject(new Error('等待后台任务已取消'))
          return
        }
        const entries = waiters.get(taskId) ?? []
        entries.push({ resolve, reject, signal })
        waiters.set(taskId, entries)
        signal?.addEventListener(
          'abort',
          () => reject(new Error('等待后台任务已取消')),
          { once: true }
        )
      })
  )
  const runtime: SessionTaskSupervisionRuntime = {
    list: vi.fn((owner) => {
      expect(owner).toEqual(parent)
      return [...tasks.values()]
    }),
    wait
  }
  const settle = (
    taskId: string,
    next: Partial<SessionTaskView> = { state: 'idle', busy: false }
  ): void => {
    const current = tasks.get(taskId)
    if (!current) throw new Error('missing task')
    const updated = { ...current, ...next, updatedAt: current.updatedAt + 1 }
    tasks.set(taskId, updated)
    const outcome =
      updated.state === 'error'
        ? 'error'
        : updated.state === 'stopped'
          ? 'stopped'
          : updated.state === 'unavailable'
            ? 'unavailable'
            : 'completed'
    for (const waiter of waiters.get(taskId) ?? []) {
      waiter.resolve({ outcome, task: updated })
    }
    waiters.delete(taskId)
  }
  return {
    supervisor: new SessionTaskSupervisor(runtime, { defaultWaitMs: 100, maxWaitMs: 500 }),
    runtime,
    wait,
    waiters,
    tasks,
    settle
  }
}

describe('session task supervision', () => {
  it('returns one bounded snapshot with settled and pending partitions', async () => {
    const { supervisor, wait } = fixture([
      task('a', { state: 'idle', busy: false }),
      task('b', { state: 'awaiting-approval', busy: true, approvals: 1 }),
      task('c', { state: 'unavailable', busy: false })
    ])

    await expect(supervisor.supervise(parent)).resolves.toEqual({
      mode: 'snapshot',
      outcome: 'snapshot',
      tasks: expect.arrayContaining([
        expect.objectContaining({ taskId: 'a', state: 'idle' }),
        expect.objectContaining({ taskId: 'b', state: 'awaiting-approval' }),
        expect.objectContaining({ taskId: 'c', state: 'unavailable' })
      ]),
      settledTaskIds: ['a', 'c'],
      pendingTaskIds: ['b']
    })
    expect(wait).not.toHaveBeenCalled()
  })

  it('returns immediately for any when one task is already settled', async () => {
    const { supervisor, wait } = fixture([
      task('a', { state: 'error', busy: false }),
      task('b')
    ])

    await expect(supervisor.supervise(parent, { mode: 'any' })).resolves.toMatchObject({
      mode: 'any',
      outcome: 'settled',
      settledTaskIds: ['a'],
      pendingTaskIds: ['b']
    })
    expect(wait).not.toHaveBeenCalled()
  })

  it('waits for any pending task and aborts the losing subscriptions', async () => {
    const { supervisor, wait, waiters, settle } = fixture([task('a'), task('b')])

    const pending = supervisor.supervise(parent, { mode: 'any', timeoutMs: 5_000 })
    await Promise.resolve()
    expect(wait).toHaveBeenCalledTimes(2)
    expect(wait.mock.calls.map((call) => call[2]?.timeoutMs)).toEqual([500, 500])

    settle('b')
    const result = await pending

    expect(result).toMatchObject({
      mode: 'any',
      outcome: 'settled',
      settledTaskIds: ['b'],
      pendingTaskIds: ['a']
    })
    expect(waiters.get('a')?.[0]?.signal?.aborted).toBe(true)
  })

  it('waits for all pending tasks before reporting all-settled', async () => {
    const { supervisor, settle } = fixture([task('a'), task('b')])

    const pending = supervisor.supervise(parent, { mode: 'all', timeoutMs: 200 })
    await Promise.resolve()
    settle('a')
    await Promise.resolve()
    settle('b', { state: 'stopped', busy: false })

    await expect(pending).resolves.toMatchObject({
      mode: 'all',
      outcome: 'all-settled',
      settledTaskIds: ['a', 'b'],
      pendingTaskIds: []
    })
  })

  it('propagates caller cancellation and tears down any-mode waits', async () => {
    const { supervisor, waiters } = fixture([task('a'), task('b')])
    const controller = new AbortController()

    const pending = supervisor.supervise(parent, {
      mode: 'any',
      timeoutMs: 100,
      signal: controller.signal
    })
    await Promise.resolve()
    controller.abort()

    await expect(pending).rejects.toThrow('已取消')
    expect(waiters.get('a')?.[0]?.signal?.aborted).toBe(true)
    expect(waiters.get('b')?.[0]?.signal?.aborted).toBe(true)
  })

  it('reports empty parent scope without starting waits', async () => {
    const { supervisor, wait } = fixture([])
    await expect(supervisor.supervise(parent, { mode: 'all' })).resolves.toEqual({
      mode: 'all',
      outcome: 'empty',
      tasks: [],
      settledTaskIds: [],
      pendingTaskIds: []
    })
    expect(wait).not.toHaveBeenCalled()
  })

  it('validates supervision timeout policy', () => {
    const runtime = fixture([]).runtime
    expect(() => new SessionTaskSupervisor(runtime, { defaultWaitMs: -1 })).toThrow(
      'non-negative'
    )
    expect(
      () => new SessionTaskSupervisor(runtime, { defaultWaitMs: 10, maxWaitMs: 5 })
    ).toThrow('at least as large')
  })
})
