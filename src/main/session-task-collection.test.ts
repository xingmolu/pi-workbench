import { describe, expect, it, vi } from 'vitest'
import type {
  SessionTaskParent,
  SessionTaskResult,
  SessionTaskView
} from './session-task-orchestrator'
import { SessionTaskCollector } from './session-task-collection'

const parent: SessionTaskParent = {
  workerId: 'parent-worker',
  sessionId: 'parent-session',
  generation: 5
}

function task(taskId: string, state: SessionTaskView['state']): SessionTaskView {
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
    updatedAt: 2,
    state,
    busy: state === 'running' || state === 'awaiting-approval',
    queuedCount: 0,
    approvals: state === 'awaiting-approval' ? 1 : 0
  }
}

function item(
  view: SessionTaskView,
  result: SessionTaskResult['result']
): SessionTaskResult {
  return { task: view, result }
}

describe('session task collection', () => {
  it('aggregates ready, pending and attention outcomes without copying a new transcript', () => {
    const ready = task('ready', 'idle')
    const pending = task('pending', 'running')
    const ambiguous = task('ambiguous', 'idle')
    const unavailable = task('gone', 'unavailable')
    const byId = new Map<string, SessionTaskResult>([
      [
        ready.taskId,
        item(ready, {
          outcome: 'ready',
          entryId: 'assistant-1',
          markdown: 'canonical answer',
          originalLength: 16,
          truncated: false
        })
      ],
      [pending.taskId, item(pending, { outcome: 'pending' })],
      [ambiguous.taskId, item(ambiguous, { outcome: 'ambiguous' })],
      [unavailable.taskId, item(unavailable, { outcome: 'unavailable' })]
    ])
    const runtime = {
      list: vi.fn(() => [ready, pending, ambiguous, unavailable]),
      result: vi.fn((_parent: SessionTaskParent, taskId: string) => byId.get(taskId)!)
    }
    const collector = new SessionTaskCollector(runtime)

    expect(collector.collect(parent)).toEqual({
      items: [
        byId.get('ready'),
        byId.get('pending'),
        byId.get('ambiguous'),
        byId.get('gone')
      ],
      readyTaskIds: ['ready'],
      pendingTaskIds: ['pending'],
      attentionTaskIds: ['ambiguous', 'gone']
    })
    expect(runtime.list).toHaveBeenCalledWith(parent)
    expect(runtime.result.mock.calls).toEqual([
      [parent, 'ready'],
      [parent, 'pending'],
      [parent, 'ambiguous'],
      [parent, 'gone']
    ])
  })

  it('returns an empty bounded collection when the parent has no tasks', () => {
    const runtime = {
      list: vi.fn((): SessionTaskView[] => []),
      result: vi.fn()
    }
    const collector = new SessionTaskCollector(runtime)

    expect(collector.collect(parent)).toEqual({
      items: [],
      readyTaskIds: [],
      pendingTaskIds: [],
      attentionTaskIds: []
    })
    expect(runtime.result).not.toHaveBeenCalled()
  })

  it('preserves explicit error/no-result/stopped outcomes as attention instead of guessing text', () => {
    const values = [
      item(task('error', 'error'), { outcome: 'error' }),
      item(task('stopped', 'stopped'), { outcome: 'stopped' }),
      item(task('empty', 'idle'), { outcome: 'no-result' })
    ]
    const runtime = {
      list: vi.fn(() => values.map((value) => value.task)),
      result: vi.fn((_parent: SessionTaskParent, taskId: string) =>
        values.find((value) => value.task.taskId === taskId)!
      )
    }

    expect(new SessionTaskCollector(runtime).collect(parent)).toMatchObject({
      readyTaskIds: [],
      pendingTaskIds: [],
      attentionTaskIds: ['error', 'stopped', 'empty']
    })
  })
})
