import { describe, expect, it, vi } from 'vitest'
import type {
  BackgroundSessionHandle,
  BackgroundSessionStatus
} from './background-session-service'
import {
  SessionTaskOrchestrator,
  type SessionTaskRuntime
} from './session-task-orchestrator'

function fixture(options: { perParent?: number; total?: number } = {}) {
  let sequence = 0
  let now = 100
  const statuses = new Map<string, BackgroundSessionStatus>()
  const spawnFromParent = vi.fn(async (): Promise<BackgroundSessionHandle> => {
    sequence += 1
    const workerId = `worker-${sequence}`
    const handle = {
      workerId,
      sessionId: `session-${sequence}`,
      generation: sequence,
      projectPath: '/project'
    }
    statuses.set(workerId, {
      ...handle,
      status: 'running',
      busy: true,
      queuedCount: 0,
      approvals: 0
    })
    return handle
  })
  const send = vi.fn(async (handle: BackgroundSessionHandle) => {
    const current = statuses.get(handle.workerId)
    if (!current) throw new Error('missing worker')
    if (
      current.sessionId !== handle.sessionId ||
      current.generation !== handle.generation ||
      current.projectPath !== handle.projectPath
    ) {
      throw new Error('stale handle')
    }
    statuses.set(handle.workerId, { ...current, status: 'running', busy: true })
  })
  const abort = vi.fn(async (handle: BackgroundSessionHandle) => {
    const current = statuses.get(handle.workerId)
    if (!current) throw new Error('missing worker')
    if (
      current.sessionId !== handle.sessionId ||
      current.generation !== handle.generation ||
      current.projectPath !== handle.projectPath
    ) {
      throw new Error('stale handle')
    }
    statuses.set(handle.workerId, { ...current, status: 'stopped', busy: false })
  })
  const runtime: SessionTaskRuntime = {
    spawnFromParent,
    send,
    abort,
    status: (handle) => {
      const status = statuses.get(handle.workerId)
      if (!status) throw new Error('worker gone')
      if (
        status.sessionId !== handle.sessionId ||
        status.generation !== handle.generation ||
        status.projectPath !== handle.projectPath
      ) {
        throw new Error('stale handle')
      }
      return status
    }
  }
  const orchestrator = new SessionTaskOrchestrator(runtime, {
    maxWorkersPerParent: options.perParent ?? 4,
    maxWorkersTotal: options.total ?? 16,
    createTaskId: () => `task-${sequence}`,
    now: () => ++now
  })
  return { orchestrator, runtime, statuses, spawnFromParent, send, abort }
}

describe('session task orchestrator', () => {
  it('spawns parent-scoped tasks over ordinary background sessions', async () => {
    const { orchestrator, spawnFromParent } = fixture()

    const task = await orchestrator.spawn('parent-a', 'inspect tests')

    expect(spawnFromParent).toHaveBeenCalledWith('parent-a', 'inspect tests')
    expect(task).toMatchObject({
      taskId: 'task-1',
      parentWorkerId: 'parent-a',
      workerId: 'worker-1',
      sessionId: 'session-1',
      projectPath: '/project',
      state: 'running',
      busy: true
    })
    expect(task).not.toHaveProperty('prompt')
  })

  it('enforces parent scope and passes the durable handle to control operations', async () => {
    const { orchestrator, send, abort, statuses } = fixture()
    const task = await orchestrator.spawn('parent-a', 'first')
    const handle = {
      workerId: 'worker-1',
      sessionId: 'session-1',
      generation: 1,
      projectPath: '/project'
    }

    expect(() => orchestrator.status('parent-b', task.taskId)).toThrow('不属于')
    await expect(orchestrator.send('parent-b', task.taskId, 'second')).rejects.toThrow('不属于')
    await expect(orchestrator.cancel('parent-b', task.taskId)).rejects.toThrow('不属于')
    expect(() => orchestrator.release('parent-b', task.taskId)).toThrow('不属于')

    await orchestrator.send('parent-a', task.taskId, 'second')
    expect(send).toHaveBeenCalledWith(handle, 'second')
    await orchestrator.cancel('parent-a', task.taskId)
    expect(abort).toHaveBeenCalledWith(handle)
    expect(statuses.get('worker-1')?.status).toBe('stopped')
  })

  it('degrades stale worker identity to unavailable and refuses stale controls', async () => {
    const { orchestrator, statuses, send, abort } = fixture()
    const task = await orchestrator.spawn('parent-a', 'first')
    const current = statuses.get(task.workerId)!
    statuses.set(task.workerId, {
      ...current,
      sessionId: 'replacement',
      generation: current.generation + 1
    })

    expect(orchestrator.status('parent-a', task.taskId).state).toBe('unavailable')
    await expect(orchestrator.send('parent-a', task.taskId, 'stale')).rejects.toThrow('stale handle')
    await expect(orchestrator.cancel('parent-a', task.taskId)).rejects.toThrow('stale handle')
    expect(send).toHaveBeenCalledTimes(1)
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('prevents recursive workers and enforces per-parent and global relation limits', async () => {
    const { orchestrator } = fixture({ perParent: 2, total: 3 })
    const first = await orchestrator.spawn('parent-a', 'one')
    await orchestrator.spawn('parent-a', 'two')

    await expect(orchestrator.spawn('parent-a', 'three')).rejects.toThrow('父会话')
    await expect(orchestrator.spawn(first.workerId, 'recursive')).rejects.toThrow('不能继续创建')

    await orchestrator.spawn('parent-b', 'three')
    await expect(orchestrator.spawn('parent-c', 'four')).rejects.toThrow('总数')
  })

  it('does not consume a relation slot when runtime spawn fails', async () => {
    const { orchestrator, runtime } = fixture({ perParent: 1, total: 1 })
    vi.mocked(runtime.spawnFromParent).mockRejectedValueOnce(new Error('spawn failed'))

    await expect(orchestrator.spawn('parent-a', 'broken')).rejects.toThrow('spawn failed')
    await expect(orchestrator.spawn('parent-a', 'retry')).resolves.toMatchObject({
      parentWorkerId: 'parent-a'
    })
  })

  it('lists bounded live status and degrades a vanished worker to unavailable', async () => {
    const { orchestrator, statuses } = fixture()
    const first = await orchestrator.spawn('parent-a', 'one')
    const second = await orchestrator.spawn('parent-a', 'two')
    await orchestrator.spawn('parent-b', 'other parent')

    statuses.set(first.workerId, {
      ...statuses.get(first.workerId)!,
      status: 'awaiting-approval',
      busy: true,
      approvals: 1
    })
    statuses.delete(second.workerId)

    expect(orchestrator.list('parent-a')).toMatchObject([
      {
        taskId: first.taskId,
        state: 'awaiting-approval',
        busy: true,
        approvals: 1
      },
      {
        taskId: second.taskId,
        state: 'unavailable',
        busy: false,
        approvals: 0
      }
    ])
    expect(orchestrator.list('parent-a')).toHaveLength(2)
  })

  it('releases only settled relationships and never deletes the worker session', async () => {
    const { orchestrator, statuses, abort } = fixture({ perParent: 1, total: 1 })
    const task = await orchestrator.spawn('parent-a', 'work')

    expect(() => orchestrator.release('parent-a', task.taskId)).toThrow('仍在运行')
    await orchestrator.cancel('parent-a', task.taskId)
    orchestrator.release('parent-a', task.taskId)

    expect(orchestrator.list('parent-a')).toEqual([])
    expect(abort).toHaveBeenCalledTimes(1)
    expect(statuses.has(task.workerId)).toBe(true)
    await expect(orchestrator.spawn('parent-a', 'next')).resolves.toMatchObject({
      parentWorkerId: 'parent-a'
    })
  })

  it('fails constructor validation for invalid concurrency policy', () => {
    const runtime = fixture().runtime
    expect(() => new SessionTaskOrchestrator(runtime, { maxWorkersPerParent: 0 })).toThrow(
      'positive integer'
    )
    expect(
      () => new SessionTaskOrchestrator(runtime, { maxWorkersPerParent: 4, maxWorkersTotal: 3 })
    ).toThrow('at least as large')
  })
})
