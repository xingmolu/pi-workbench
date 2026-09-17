import { describe, expect, it, vi } from 'vitest'
import type {
  BackgroundSessionHandle,
  BackgroundSessionStatus,
  BackgroundSessionWaitResult
} from './background-session-service'
import {
  SessionTaskOrchestrator,
  type SessionTaskRuntime
} from './session-task-orchestrator'

const handle: BackgroundSessionHandle = {
  workerId: 'worker-1',
  sessionId: 'session-1',
  generation: 1,
  projectPath: '/project'
}

function status(
  overrides: Partial<BackgroundSessionStatus> = {}
): BackgroundSessionStatus {
  return {
    ...handle,
    status: 'running',
    busy: true,
    queuedCount: 0,
    approvals: 0,
    ...overrides
  }
}

function fixture(waitResult: BackgroundSessionWaitResult = {
  outcome: 'completed',
  status: status({ status: 'idle', busy: false })
}) {
  let now = 100
  const wait = vi.fn(async () => waitResult)
  const runtime: SessionTaskRuntime = {
    spawnFromParent: vi.fn(async () => handle),
    send: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    status: vi.fn(() => status()),
    wait
  }
  const orchestrator = new SessionTaskOrchestrator(runtime, {
    defaultWaitMs: 100,
    maxWaitMs: 500,
    createTaskId: () => 'task-1',
    now: () => ++now
  })
  return { orchestrator, runtime, wait }
}

describe('session task wait policy', () => {
  it('bounds requested wait time and returns the settled lifecycle projection', async () => {
    const { orchestrator, wait } = fixture()
    const spawned = await orchestrator.spawn('parent-a', 'work')

    const result = await orchestrator.wait('parent-a', spawned.taskId, { timeoutMs: 5_000 })

    expect(wait).toHaveBeenCalledWith(handle, { timeoutMs: 500 })
    expect(result).toMatchObject({
      outcome: 'completed',
      task: {
        taskId: spawned.taskId,
        state: 'idle',
        busy: false
      }
    })
    expect(result.task.updatedAt).toBeGreaterThan(spawned.updatedAt)
  })

  it('uses the default bounded wait when the caller omits a timeout', async () => {
    const { orchestrator, wait } = fixture({
      outcome: 'timeout',
      status: status()
    })
    const spawned = await orchestrator.spawn('parent-a', 'work')

    const result = await orchestrator.wait('parent-a', spawned.taskId)

    expect(wait).toHaveBeenCalledWith(handle, { timeoutMs: 100 })
    expect(result).toMatchObject({
      outcome: 'timeout',
      task: { state: 'running', busy: true }
    })
  })

  it('fails closed if a runtime returns a wait result for another durable identity', async () => {
    const { orchestrator } = fixture({
      outcome: 'completed',
      status: status({ sessionId: 'replacement', status: 'idle', busy: false })
    })
    const spawned = await orchestrator.spawn('parent-a', 'work')

    await expect(orchestrator.wait('parent-a', spawned.taskId)).resolves.toMatchObject({
      outcome: 'unavailable',
      task: { state: 'unavailable' }
    })
  })

  it('keeps wait parent-scoped and reports missing lifecycle support explicitly', async () => {
    const { orchestrator, runtime, wait } = fixture()
    const spawned = await orchestrator.spawn('parent-a', 'work')

    await expect(orchestrator.wait('parent-b', spawned.taskId)).rejects.toThrow('不属于')
    expect(wait).not.toHaveBeenCalled()

    const withoutWait = new SessionTaskOrchestrator({
      spawnFromParent: runtime.spawnFromParent,
      send: runtime.send,
      abort: runtime.abort,
      status: runtime.status
    })
    const other = await withoutWait.spawn('parent-a', 'work')
    await expect(withoutWait.wait('parent-a', other.taskId)).rejects.toThrow('不支持事件等待')
  })
})
