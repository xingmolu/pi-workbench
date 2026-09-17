import type {
  SessionTaskParent,
  SessionTaskView
} from './session-task-orchestrator'

export type SessionTaskDelegationRuntime = {
  spawn(parent: SessionTaskParent, prompt: string): Promise<SessionTaskView>
}

export type SessionTaskDelegationItem =
  | {
      index: number
      status: 'spawned'
      task: SessionTaskView
    }
  | {
      index: number
      status: 'failed'
      error: string
    }

export type SessionTaskDelegationResult = {
  items: SessionTaskDelegationItem[]
  spawnedTaskIds: string[]
  failedIndexes: number[]
}

export type SessionTaskDelegatorOptions = {
  maxBatch?: number
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message || '后台任务创建失败').slice(0, 4096)
}

/**
 * Stateless batch admission policy over ordinary SessionTask.spawn().
 *
 * Admission is intentionally sequential even though admitted workers execute
 * concurrently. SessionTaskOrchestrator owns the per-parent/global worker
 * limits; serial admission prevents multiple concurrent spawn() calls from all
 * observing the same pre-admission count and oversubscribing those limits.
 *
 * Runtime failures are reported per item. Already-admitted workers are never
 * rolled back automatically because their prompts may already be executing.
 */
export class SessionTaskDelegator {
  private readonly maxBatch: number

  constructor(
    private readonly runtime: SessionTaskDelegationRuntime,
    options: SessionTaskDelegatorOptions = {}
  ) {
    this.maxBatch = options.maxBatch ?? 4
    if (!Number.isInteger(this.maxBatch) || this.maxBatch < 1 || this.maxBatch > 16) {
      throw new Error('maxBatch must be an integer between 1 and 16')
    }
  }

  async delegate(
    parent: SessionTaskParent,
    prompts: readonly string[]
  ): Promise<SessionTaskDelegationResult> {
    if (prompts.length < 1 || prompts.length > this.maxBatch) {
      throw new Error(`delegate requires between 1 and ${this.maxBatch} tasks`)
    }
    const normalized = prompts.map((prompt) => prompt.trim())
    if (normalized.some((prompt) => !prompt)) {
      throw new Error('delegate tasks cannot be empty')
    }

    const items: SessionTaskDelegationItem[] = []
    for (let index = 0; index < normalized.length; index += 1) {
      try {
        const task = await this.runtime.spawn(parent, normalized[index])
        items.push({ index, status: 'spawned', task })
      } catch (error) {
        items.push({ index, status: 'failed', error: safeError(error) })
      }
    }

    return {
      items,
      spawnedTaskIds: items.flatMap((item) =>
        item.status === 'spawned' ? [item.task.taskId] : []
      ),
      failedIndexes: items.flatMap((item) =>
        item.status === 'failed' ? [item.index] : []
      )
    }
  }
}
