import { describe, expect, it, vi } from 'vitest'
import type {
  BackgroundSessionHandle,
  BackgroundSessionStatus,
  BackgroundSessionWaitResult
} from './background-session-service'
import {
  SessionTaskOrchestrator,
  type SessionTaskParent,
  type SessionTaskRuntime,
  type SessionTaskView
} from './session-task-orchestrator'

const parent: SessionTaskParent = {
  workerId: 'parent-worker',
  sessionId: 'parent-session',
  generation: 7
}

async function fixture(count: number) {
  let sequence = 0
  const statuses = new Map<string, BackgroundSessionStatus>()
  const waiters = new Map<
    string,
    Array<{
      resolve(value: BackgroundSessionWaitResult): void
      reject(error: Error): void
      signal?: AbortSignal
    }>
  >()
  const wait = vi.fn(
    (handle: BackgroundSessionHandle, options: { timeoutMs: number; signal?: AbortSignal }) =>
      new Promise<BackgroundSessionWaitResult>((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('等待后台任务已取消'))
          return
        }
        const current = statuses.get(handle.workerId)
        if (!current) {
          resolve({ outcome: 'unavailable', status: null })
          return
        }
        if (!current.busy && ['idle', 'error', 'stopped'].includes(current.status)) {
          resolve({
            outcome:
              current.status === 'error'
                ? 'error'
                : current.status === 'stopped'
                  ? 'stopped'
                  : 'completed',
            status: current
          })
          return
        }
        const entries = waiters.get(handle.workerId) ?? []
        entries.push({ resolve, reject, signal: options.signal })
        waiters.set(handle.workerId, entries)
        options.signal?.addEventListener(
          'abort',
          () => reject(new Error('等待后台任务已取消')),
          { once: true }
        )
      })
  )
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
      return handle
    }),
    send: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    status: (handle) => {
      const status = statuses.get(handle.workerId)
      if (!status) throw new Error('worker gone')
      return status
    },
    wait
  }
  const orchestrator = new SessionTaskOrchestrator(runtime, {
    defaultWaitMs: 100,
    maxWaitMs: 500,
    createTaskId: () => `task-${sequence}`
  })
  const tasks: SessionTaskView[] = []
  for (let index = 0; index < count; index += 1) {
    tasks.push(await orchestrator.spawn(parent, `task ${index + 1}`))
  }
  const setStatus = (task: SessionTaskView, next: Partial<BackgroundSessionStatus>): void => {
    const current = statuses.get(task.workerId)
    if (!current) throw new Error('missing task')
    statuses.set(task.workerId, { ...current, ...next })
  }
  const settle = (
    task: SessionTaskView,
    next: Partial<BackgroundSessionStatus> = { status: 'idle', busy: false }
  ): void => {
    setStatus(task, next)
    const current = statuses.get(task.workerId)!
    const outcome =
      current.status === 'error'
        ? 'error'
        : current.status === 'stopped'
          ? 'stopped'
          : 'completed'
    for (const waiter of waiters.get(task.workerId) ?? []) waiter.resolve({ outcome, status: current })
    waiters.delete(task.workerId)
  }
  return { orchestrator, tasks, wait, waiters, setStatus, settle }
}

describe('session task supervision', () => {
  it('returns one bounded snapshot with settled and pending partitions', async () => {
    const { orchestrator, tasks, wait, setStatus } = await fixture(3)
    setStatus(tasks[0], { status: 'idle', busy: false })
    setStatus(tasks[1], { status: 'awaiting-approval', busy: true, approvals: 1 })
    statusesUnavailable(tasks[2], setStatus)

    await expect(orchestrator.supervise(parent)).resolves.toMatchObject({
      mode: 'snapshot',
      outcome: 'snapshot',
      settledTaskIds: [tasks[0].taskId, tasks[2].taskId],
      pendingTaskIds: [tasks[1].taskId]
    })
    expect(wait).not.toHaveBeenCalled()
  })

  it('returns immediately for any when one task is already settled', async () => {
    const { orchestrator, tasks, wait, setStatus } = await fixture(2)
    setStatus(tasks[0], { status: 'error', busy: false })

    await expect(orchestrator.supervise(parent, { mode: 'any' })).resolves.toMatchObject({
      outcome: 'settled',
      settledTaskIds: [tasks[0].taskId],
      pendingTaskIds: [tasks[1].taskId]
    })
    expect(wait).not.toHaveBeenCalled()
  })

  it('waits for any pending task and aborts the losing subscription', async () => {
    const { orchestrator, tasks, wait, waiters, settle } = await fixture(2)

    const pending = orchestrator.supervise(parent, { mode: 'any', timeoutMs: 5_000 })
    await Promise.resolve()
    expect(wait).toHaveBeenCalledTimes(2)
    expect(wait.mock.calls.map((call) => call[1].timeoutMs)).toEqual([500, 500])

    settle(tasks[1])
    await expect(pending).resolves.toMatchObject({
      outcome: 'settled',
      settledTaskIds: [tasks[1].taskId],
      pendingTaskIds: [tasks[0].taskId]
    })
    expect(waiters.get(tasks[0].workerId)?.[0]?.signal?.aborted).toBe(true)
  })

  it('waits for all pending tasks and propagates caller cancellation', async () => {
    const { orchestrator, tasks, settle } = await fixture(2)
    const pending = orchestrator.supervise(parent, { mode: 'all', timeoutMs: 200 })
    await Promise.resolve()
    settle(tasks[0])
    settle(tasks[1], { status: 'stopped', busy: false })
    await expect(pending).resolves.toMatchObject({
      outcome: 'all-settled',
      settledTaskIds: [tasks[0].taskId, tasks[1].taskId]
    })

    const next = await fixture(2)
    const controller = new AbortController()
    const cancelled = next.orchestrator.supervise(parent, {
      mode: 'any',
      timeoutMs: 100,
      signal: controller.signal
    })
    await Promise.resolve()
    controller.abort()
    await expect(cancelled).rejects.toThrow('已取消')
  })

  it('reports empty parent scope without starting waits', async () => {
    const { orchestrator, wait } = await fixture(0)
    await expect(orchestrator.supervise(parent, { mode: 'all' })).resolves.toEqual({
      mode: 'all',
      outcome: 'empty',
      tasks: [],
      settledTaskIds: [],
      pendingTaskIds: []
    })
    expect(wait).not.toHaveBeenCalled()
  })
})

function statusesUnavailable(
  task: SessionTaskView,
  setStatus: (task: SessionTaskView, next: Partial<BackgroundSessionStatus>) => void
): void {
  setStatus(task, { status: 'stopped', busy: false })
}
