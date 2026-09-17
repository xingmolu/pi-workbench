import type {
  SessionTaskParent,
  SessionTaskResult,
  SessionTaskView
} from './session-task-orchestrator'

export type SessionTaskCollection = {
  items: SessionTaskResult[]
  readyTaskIds: string[]
  pendingTaskIds: string[]
  attentionTaskIds: string[]
}

export type SessionTaskCollectionRuntime = {
  list(parent: SessionTaskParent): SessionTaskView[]
  result(parent: SessionTaskParent, taskId: string): SessionTaskResult
}

/**
 * Stateless canonical-result aggregation for one parent session.
 *
 * The collector does not cache transcript/result text and never invents an
 * answer. It reuses SessionTaskOrchestrator.result(), which already enforces
 * parent ownership and the BackgroundSessionService canonical result cursor.
 */
export class SessionTaskCollector {
  constructor(private readonly runtime: SessionTaskCollectionRuntime) {}

  collect(parent: SessionTaskParent): SessionTaskCollection {
    const tasks = this.runtime.list(parent)
    const items = tasks.map((task) => this.runtime.result(parent, task.taskId))
    const readyTaskIds: string[] = []
    const pendingTaskIds: string[] = []
    const attentionTaskIds: string[] = []

    for (const item of items) {
      if (item.result.outcome === 'ready') readyTaskIds.push(item.task.taskId)
      else if (item.result.outcome === 'pending') pendingTaskIds.push(item.task.taskId)
      else attentionTaskIds.push(item.task.taskId)
    }

    return { items, readyTaskIds, pendingTaskIds, attentionTaskIds }
  }
}
