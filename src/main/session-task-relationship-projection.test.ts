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

describe('SessionTask relationship projection', () => {
  it('publishes stable parent-child metadata and notifies when the relation changes', async () => {
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
    const runtime: SessionTaskRuntime = {
      spawnFromParent: vi.fn(async () => handle),
      send: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      status: () => status
    }
    const orchestrator = new SessionTaskOrchestrator(runtime, {
      createTaskId: () => 'task-1',
      now: () => 123,
      onTasksChanged: changed
    })

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

    status = { ...status, status: 'idle', busy: false }
    orchestrator.release(parent, task.taskId)

    expect(orchestrator.relationships()).toEqual([])
    expect(changed).toHaveBeenCalledTimes(2)
  })
})
