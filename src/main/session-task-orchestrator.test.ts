import { describe, expect, it, vi } from 'vitest'
import type {
  BackgroundSessionHandle,
  BackgroundSessionStatus
} from './background-session-service'
import {
  SessionTaskOrchestrator,
  type SessionTaskParent,
  type SessionTaskRuntime
} from './session-task-orchestrator'

const parentA: SessionTaskParent = {
  workerId: 'parent-a',
  sessionId: 'parent-session-a',
  generation: 1
}
const parentB: SessionTaskParent = {
  workerId: 'parent-b',
  sessionId: 'parent-session-b',
  generation: 1
}

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
  it('spawns parent-session-scoped tasks over ordinary background sessions', async () => {
    const { orchestrator, spawnFromParent } = fixture()

    const task = await orchestrator.spawn(parentA, 'inspect tests')

    expect(spawnFromParent).toHaveBeenCalledWith(parentA, 'inspect tests')
    expect(task).toMatchObject({
      taskId: 'task-1',
      parentWorkerId: parentA.workerId,
      parentSessionId: parentA.sessionId,
      parentGeneration: parentA.generation,
      workerId: 'worker-1',
      sessionId: 'session-1',
      projectPath: '/project',
      state: 'running',
      busy: true
    })
    expect(task).not.toHaveProperty('prompt')
  })

  it('does not transfer task authority when the same parent worker changes session identity', async () => {
    const { orchestrator, send, abort } = fixture()
    const task = await orchestrator.spawn(parentA, 'first')
    const replacementParent = {
      ...parentA,
      sessionId: 'replacement-parent-session',
      generation: parentA.generation + 1
    }

    expect(() => orchestrator.status(replacementParent, task.taskId)).toThrow('不属于')
    await expect(orchestrator.send(replacementParent, task.taskId, 'second')).rejects.toThrow('不属于')
    await expect(orchestrator.cancel(replacementParent, task.taskId)).rejects.toThrow('不属于')
    expect(orchestrator.list(replacementParent)).toEqual([])
    expect(send).not.toHaveBeenCalled()
    expect(abort).not.toHaveBeenCalled()
  })

  it('enforces parent scope and passes the durable child handle to control operations', async () => {
    const { orchestrator, send, abort, statuses } = fixture()
    const task = await orchestrator.spawn(parentA, 'first')
    const handle = {
      workerId: 'worker-1',
      sessionId: 'session-1',
      generation: 1,
      projectPath: '/project'
    }

    expect(() => orchestrator.status(parentB, task.taskId)).toThrow('不属于')
    await expect(orchestrator.send(parentB, task.taskId, 'second')).rejects.toThrow('不属于')
    await expect(orchestrator.cancel(parentB, task.taskId)).rejects.toThrow('不属于')
    expect(() => orchestrator.release(parentB, task.taskId)).toThrow('不属于')

    await orchestrator.send(parentA, task.taskId, 'second')
    expect(send).toHaveBeenCalledWith(handle, 'second')
    await orchestrator.cancel(parentA, task.taskId)
    expect(abort).toHaveBeenCalledWith(handle)
    expect(statuses.get('worker-1')?.status).toBe('stopped')
  })

  it('degrades stale child identity to unavailable and refuses stale controls', async () => {
    const { orchestrator, statuses, send, abort } = fixture()
    const task = await orchestrator.spawn(parentA, 'first')
    const current = statuses.get(task.workerId)!
    statuses.set(task.workerId, {
      ...current,
      sessionId: 'replacement',
      generation: current.generation + 1
    })

    expect(orchestrator.status(parentA, task.taskId).state).toBe('unavailable')
    await expect(orchestrator.send(parentA, task.taskId, 'stale')).rejects.toThrow('stale handle')
    await expect(orchestrator.cancel(parentA, task.taskId)).rejects.toThrow('stale handle')
    expect(send).toHaveBeenCalledTimes(1)
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('prevents recursive workers and enforces per-parent and global relation limits', async () => {
    const { orchestrator } = fixture({ perParent: 2, total: 3 })
    const first = await orchestrator.spawn(parentA, 'one')
    await orchestrator.spawn(parentA, 'two')

    await expect(orchestrator.spawn(parentA, 'three')).rejects.toThrow('父会话')
    await expect(
      orchestrator.spawn(
        {
          workerId: first.workerId,
          sessionId: first.sessionId,
          generation: first.generation
        },
        'recursive'
      )
    ).rejects.toThrow('不能继续创建')

    await orchestrator.spawn(parentB, 'three')
    await expect(
      orchestrator.spawn(
        { workerId: 'parent-c', sessionId: 'parent-session-c', generation: 1 },
        'four'
      )
    ).rejects.toThrow('总数')
  })

  it('does not consume a relation slot when runtime spawn fails', async () => {
    const { orchestrator, runtime } = fixture({ perParent: 1, total: 1 })
    vi.mocked(runtime.spawnFromParent).mockRejectedValueOnce(new Error('spawn failed'))

    await expect(orchestrator.spawn(parentA, 'broken')).rejects.toThrow('spawn failed')
    await expect(orchestrator.spawn(parentA, 'retry')).resolves.toMatchObject({
      parentWorkerId: parentA.workerId,
      parentSessionId: parentA.sessionId
    })
  })

  it('lists bounded live status and degrades a vanished worker to unavailable', async () => {
    const { orchestrator, statuses } = fixture()
    const first = await orchestrator.spawn(parentA, 'one')
    const second = await orchestrator.spawn(parentA, 'two')
    await orchestrator.spawn(parentB, 'other parent')

    statuses.set(first.workerId, {
      ...statuses.get(first.workerId)!,
      status: 'awaiting-approval',
      busy: true,
      approvals: 1
    })
    statuses.delete(second.workerId)

    expect(orchestrator.list(parentA)).toMatchObject([
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
    expect(orchestrator.list(parentA)).toHaveLength(2)
  })

  it('releases only settled relationships and never deletes the worker session', async () => {
    const { orchestrator, statuses, abort } = fixture({ perParent: 1, total: 1 })
    const task = await orchestrator.spawn(parentA, 'work')

    expect(() => orchestrator.release(parentA, task.taskId)).toThrow('仍在运行')
    await orchestrator.cancel(parentA, task.taskId)
    orchestrator.release(parentA, task.taskId)

    expect(orchestrator.list(parentA)).toEqual([])
    expect(abort).toHaveBeenCalledTimes(1)
    expect(statuses.has(task.workerId)).toBe(true)
    await expect(orchestrator.spawn(parentA, 'next')).resolves.toMatchObject({
      parentWorkerId: parentA.workerId
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
