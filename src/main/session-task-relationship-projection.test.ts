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
  const changed = vi.fn()
  const handle: BackgroundSessionHandle = {
    workerId: 'child-worker',
    sessionId: 'child-session',
    generation: 7,
    projectPath: '/project'
  }
  let status: BackgroundSessionStatus = {
    ...handle,
    status: 'running',
    busy: true,
    queuedCount: 0,
    approvals: 0
  }
  const abort = vi.fn(async () => undefined)
  const runtime: SessionTaskRuntime = {
    spawnFromParent: vi.fn(async () => handle),
    send: vi.fn(async () => undefined),
    abort,
    status: () => status
  }
  const orchestrator = new SessionTaskOrchestrator(runtime, {
    createTaskId: () => 'task-1',
    now: () => 123,
    onTasksChanged: changed
  })
  return {
    orchestrator,
    handle,
    changed,
    abort,
    setStatus: (next: BackgroundSessionStatus) => {
      status = next
    }
  }
}

describe('SessionTask relationship projection', () => {
  it('publishes stable parent-child metadata and notifies when the relation changes', async () => {
    const { orchestrator, handle, changed, setStatus } = fixture()

    const task = await orchestrator.spawn(parent, 'fix group A')

    expect(orchestrator.relationships()).toEqual([
      {
        taskId: 'task-1',
        parentWorkerId: parent.workerId,
        parentSessionId: parent.sessionId,
        parentGeneration: parent.generation,
        workerId: handle.workerId,
        createdAt: task.createdAt
      }
    ])
    expect(changed).toHaveBeenCalledTimes(1)

    setStatus({
      ...handle,
      status: 'idle',
      busy: false,
      queuedCount: 0,
      approvals: 0
    })
    orchestrator.release(parent, task.taskId)

    expect(orchestrator.relationships()).toEqual([])
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('retires parent ownership without cancelling or deleting the child session', async () => {
    const { orchestrator, handle, changed, abort } = fixture()
    await orchestrator.spawn(parent, 'keep working after parent exits')

    expect(orchestrator.retireParent(parent.workerId)).toBe(1)

    expect(orchestrator.relationships()).toEqual([])
    expect(abort).not.toHaveBeenCalled()
    expect(() => orchestrator.status(parent, 'task-1')).toThrow('不存在或不属于')
    expect(changed).toHaveBeenCalledTimes(2)
    expect(handle.workerId).toBe('child-worker')
  })

  it('keeps the current parent identity and retires only a replaced identity', async () => {
    const { orchestrator, changed } = fixture()
    await orchestrator.spawn(parent, 'identity fencing')

    expect(
      orchestrator.retireParent(parent.workerId, {
        sessionId: parent.sessionId,
        generation: parent.generation
      })
    ).toBe(0)
    expect(orchestrator.relationships()).toHaveLength(1)
    expect(changed).toHaveBeenCalledTimes(1)

    expect(
      orchestrator.retireParent(parent.workerId, {
        sessionId: 'replacement-session',
        generation: parent.generation + 1
      })
    ).toBe(1)
    expect(orchestrator.relationships()).toEqual([])
    expect(changed).toHaveBeenCalledTimes(2)
  })
})
