import { describe, expect, it, vi } from 'vitest'
import type {
  BackgroundSessionHandle,
  BackgroundSessionResult,
  BackgroundSessionStatus
} from './background-session-service'
import {
  SessionTaskOrchestrator,
  type SessionTaskParent,
  type SessionTaskRuntime
} from './session-task-orchestrator'

const parent: SessionTaskParent = {
  workerId: 'parent-a',
  sessionId: 'parent-session-a',
  generation: 1
}
const handle: BackgroundSessionHandle = {
  workerId: 'worker-1',
  sessionId: 'session-1',
  generation: 1,
  projectPath: '/project'
}

function status(overrides: Partial<BackgroundSessionStatus> = {}): BackgroundSessionStatus {
  return {
    ...handle,
    status: 'idle',
    busy: false,
    queuedCount: 0,
    approvals: 0,
    ...overrides
  }
}

function fixture(resultValue: BackgroundSessionResult = {
  outcome: 'ready',
  entryId: 'assistant-entry',
  markdown: 'worker report',
  originalLength: 13,
  truncated: false
}) {
  const result = vi.fn(() => resultValue)
  const runtime: SessionTaskRuntime = {
    spawnFromParent: vi.fn(async () => handle),
    send: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    status: vi.fn(() => status()),
    result
  }
  const orchestrator = new SessionTaskOrchestrator(runtime, {
    createTaskId: () => 'task-1',
    now: () => 100
  })
  return { orchestrator, runtime, result }
}

describe('session task result policy', () => {
  it('keeps canonical result lookup parent-session-scoped and passes the durable handle', async () => {
    const { orchestrator, result } = fixture()
    const task = await orchestrator.spawn(parent, 'inspect')
    const replacementParent = { ...parent, sessionId: 'replacement-parent', generation: 2 }

    expect(() => orchestrator.result(replacementParent, task.taskId)).toThrow('不属于')
    expect(result).not.toHaveBeenCalled()

    expect(orchestrator.result(parent, task.taskId)).toEqual({
      task: expect.objectContaining({
        taskId: 'task-1',
        parentWorkerId: parent.workerId,
        parentSessionId: parent.sessionId,
        parentGeneration: parent.generation,
        state: 'idle'
      }),
      result: {
        outcome: 'ready',
        entryId: 'assistant-entry',
        markdown: 'worker report',
        originalLength: 13,
        truncated: false
      }
    })
    expect(result).toHaveBeenCalledWith(handle)
  })

  it('preserves explicit ambiguous/unavailable result outcomes without inventing text', async () => {
    const { orchestrator } = fixture({ outcome: 'ambiguous' })
    const task = await orchestrator.spawn(parent, 'inspect')

    expect(orchestrator.result(parent, task.taskId)).toEqual({
      task: expect.objectContaining({ taskId: task.taskId }),
      result: { outcome: 'ambiguous' }
    })
  })

  it('reports missing canonical-result capability instead of falling back to transcript guesses', async () => {
    const { runtime } = fixture()
    const orchestrator = new SessionTaskOrchestrator({
      spawnFromParent: runtime.spawnFromParent,
      send: runtime.send,
      abort: runtime.abort,
      status: runtime.status
    })
    const task = await orchestrator.spawn(parent, 'inspect')

    expect(() => orchestrator.result(parent, task.taskId)).toThrow('canonical 结果读取')
  })
})
