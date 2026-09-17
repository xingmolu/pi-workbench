import { describe, expect, it, vi } from 'vitest'
import type { SessionTaskParent, SessionTaskView } from './session-task-orchestrator'
import { SessionTaskDelegator } from './session-task-delegation'

const parent: SessionTaskParent = {
  workerId: 'parent-worker',
  sessionId: 'parent-session',
  generation: 4
}

function task(index: number): SessionTaskView {
  return {
    taskId: `task-${index}`,
    parentWorkerId: parent.workerId,
    parentSessionId: parent.sessionId,
    parentGeneration: parent.generation,
    workerId: `worker-${index}`,
    sessionId: `session-${index}`,
    generation: index,
    projectPath: '/project',
    createdAt: index,
    updatedAt: index,
    state: 'running',
    busy: true,
    queuedCount: 0,
    approvals: 0
  }
}

describe('session task delegation', () => {
  it('admits tasks sequentially while already admitted workers can continue running', async () => {
    const order: string[] = []
    let sequence = 0
    const spawn = vi.fn(async (_parent: SessionTaskParent, prompt: string) => {
      order.push(`start:${prompt}`)
      const index = ++sequence
      await Promise.resolve()
      order.push(`admitted:${prompt}`)
      return task(index)
    })
    const delegator = new SessionTaskDelegator({ spawn })

    const result = await delegator.delegate(parent, [' one ', 'two', 'three'])

    expect(spawn.mock.calls.map((call) => call[1])).toEqual(['one', 'two', 'three'])
    expect(order).toEqual([
      'start:one',
      'admitted:one',
      'start:two',
      'admitted:two',
      'start:three',
      'admitted:three'
    ])
    expect(result.spawnedTaskIds).toEqual(['task-1', 'task-2', 'task-3'])
    expect(result.failedIndexes).toEqual([])
    expect(result.items).toHaveLength(3)
  })

  it('preserves successful admissions and reports later failures without rollback', async () => {
    let calls = 0
    const spawn = vi.fn(async () => {
      calls += 1
      if (calls === 2) throw new Error('worker capacity reached')
      return task(calls)
    })
    const delegator = new SessionTaskDelegator({ spawn })

    const result = await delegator.delegate(parent, ['one', 'two', 'three'])

    expect(spawn).toHaveBeenCalledTimes(3)
    expect(result.spawnedTaskIds).toEqual(['task-1', 'task-3'])
    expect(result.failedIndexes).toEqual([1])
    expect(result.items).toEqual([
      expect.objectContaining({ index: 0, status: 'spawned' }),
      { index: 1, status: 'failed', error: 'worker capacity reached' },
      expect.objectContaining({ index: 2, status: 'spawned' })
    ])
  })

  it('validates the whole batch before starting side effects', async () => {
    const spawn = vi.fn(async () => task(1))
    const delegator = new SessionTaskDelegator({ spawn })

    await expect(delegator.delegate(parent, [])).rejects.toThrow('between 1 and 4')
    await expect(delegator.delegate(parent, ['one', '   '])).rejects.toThrow('cannot be empty')
    await expect(
      delegator.delegate(parent, ['one', 'two', 'three', 'four', 'five'])
    ).rejects.toThrow('between 1 and 4')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('bounds failure text and validates maxBatch configuration', async () => {
    const delegator = new SessionTaskDelegator({
      spawn: async () => {
        throw new Error('x'.repeat(5000))
      }
    })

    const result = await delegator.delegate(parent, ['one'])
    const failed = result.items[0]
    expect(failed.status).toBe('failed')
    if (failed.status === 'failed') expect(failed.error).toHaveLength(4096)

    expect(() => new SessionTaskDelegator({ spawn: async () => task(1) }, { maxBatch: 0 })).toThrow(
      'between 1 and 16'
    )
    expect(() => new SessionTaskDelegator({ spawn: async () => task(1) }, { maxBatch: 17 })).toThrow(
      'between 1 and 16'
    )
  })
})
