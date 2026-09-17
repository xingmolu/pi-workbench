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

const parent: SessionTaskParent = {
  workerId: 'parent-worker',
  sessionId: 'parent-session',
  generation: 4
}

function fixture() {
  let sequence = 0
  const statuses = new Map<string, BackgroundSessionStatus>()
  const spawnFromParent = vi.fn(async (_parent: SessionTaskParent, prompt: string) => {
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
  })
  const runtime: SessionTaskRuntime = {
    spawnFromParent,
    send: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    status: (handle) => {
      const status = statuses.get(handle.workerId)
      if (!status) throw new Error('missing worker')
      return status
    }
  }
  const orchestrator = new SessionTaskOrchestrator(runtime, {
    createTaskId: () => `task-${sequence}`
  })
  return { orchestrator, spawnFromParent }
}

describe('session task delegation', () => {
  it('admits a normalized batch sequentially', async () => {
    const { orchestrator, spawnFromParent } = fixture()

    const result = await orchestrator.delegate(parent, [' one ', 'two', 'three'])

    expect(spawnFromParent.mock.calls.map((call) => call[1])).toEqual(['one', 'two', 'three'])
    expect(result.spawnedTaskIds).toEqual(['task-1', 'task-2', 'task-3'])
    expect(result.failedIndexes).toEqual([])
  })

  it('preserves successful admissions and reports later failures without rollback', async () => {
    const { orchestrator, spawnFromParent } = fixture()
    spawnFromParent.mockRejectedValueOnce(new Error('worker capacity reached'))

    const result = await orchestrator.delegate(parent, ['one', 'two'])

    expect(result.failedIndexes).toEqual([0])
    expect(result.items[0]).toEqual({ index: 0, status: 'failed', error: 'worker capacity reached' })
    expect(result.items[1]).toMatchObject({ index: 1, status: 'spawned' })
  })

  it('validates the whole batch before starting side effects and bounds failure text', async () => {
    const { orchestrator, spawnFromParent } = fixture()

    await expect(orchestrator.delegate(parent, [])).rejects.toThrow('between 1 and 4')
    await expect(orchestrator.delegate(parent, ['one', '   '])).rejects.toThrow('cannot be empty')
    await expect(
      orchestrator.delegate(parent, ['one', 'two', 'three', 'four', 'five'])
    ).rejects.toThrow('between 1 and 4')
    expect(spawnFromParent).not.toHaveBeenCalled()

    spawnFromParent.mockRejectedValueOnce(new Error('x'.repeat(5000)))
    const result = await orchestrator.delegate(parent, ['one'])
    const failed = result.items[0]
    expect(failed.status).toBe('failed')
    if (failed.status === 'failed') expect(failed.error).toHaveLength(4096)
  })
})
