import type {
  SessionTaskParent,
  SessionTaskView,
  SessionTaskWaitOptions,
  SessionTaskWaitResult
} from './session-task-orchestrator'

export type SessionTaskSuperviseMode = 'snapshot' | 'any' | 'all'

export type SessionTaskSuperviseOptions = {
  mode?: SessionTaskSuperviseMode
  timeoutMs?: number
  signal?: AbortSignal
}

export type SessionTaskSuperviseOutcome =
  | 'snapshot'
  | 'settled'
  | 'all-settled'
  | 'timeout'
  | 'empty'

export type SessionTaskSuperviseResult = {
  mode: SessionTaskSuperviseMode
  outcome: SessionTaskSuperviseOutcome
  tasks: SessionTaskView[]
  settledTaskIds: string[]
  pendingTaskIds: string[]
}

export type SessionTaskSupervisionRuntime = {
  list(parent: SessionTaskParent): SessionTaskView[]
  wait(
    parent: SessionTaskParent,
    taskId: string,
    options?: SessionTaskWaitOptions
  ): Promise<SessionTaskWaitResult>
}

export type SessionTaskSupervisorOptions = {
  defaultWaitMs?: number
  maxWaitMs?: number
}

function isSettled(task: SessionTaskView): boolean {
  if (task.state === 'unavailable') return true
  if (task.busy || task.queuedCount > 0 || task.approvals > 0) return false
  return task.state === 'idle' || task.state === 'error' || task.state === 'stopped'
}

function summarize(
  mode: SessionTaskSuperviseMode,
  outcome: SessionTaskSuperviseOutcome,
  tasks: SessionTaskView[]
): SessionTaskSuperviseResult {
  const settledTaskIds = tasks.filter(isSettled).map((task) => task.taskId)
  const settled = new Set(settledTaskIds)
  return {
    mode,
    outcome,
    tasks,
    settledTaskIds,
    pendingTaskIds: tasks.filter((task) => !settled.has(task.taskId)).map((task) => task.taskId)
  }
}

/**
 * Stateless supervision policy over the parent-scoped SessionTask orchestrator.
 *
 * This layer never creates another task store. `snapshot` aggregates the current
 * parent-owned views; `any` and `all` compose the existing event-driven wait()
 * primitive and then re-read canonical task views from the orchestrator.
 */
export class SessionTaskSupervisor {
  private readonly defaultWaitMs: number
  private readonly maxWaitMs: number

  constructor(
    private readonly runtime: SessionTaskSupervisionRuntime,
    options: SessionTaskSupervisorOptions = {}
  ) {
    this.defaultWaitMs = options.defaultWaitMs ?? 25_000
    this.maxWaitMs = options.maxWaitMs ?? 45_000
    if (!Number.isFinite(this.defaultWaitMs) || this.defaultWaitMs < 0) {
      throw new Error('defaultWaitMs must be a non-negative finite number')
    }
    if (!Number.isFinite(this.maxWaitMs) || this.maxWaitMs < this.defaultWaitMs) {
      throw new Error('maxWaitMs must be finite and at least as large as defaultWaitMs')
    }
  }

  async supervise(
    parent: SessionTaskParent,
    options: SessionTaskSuperviseOptions = {}
  ): Promise<SessionTaskSuperviseResult> {
    const mode = options.mode ?? 'snapshot'
    const initial = this.runtime.list(parent)
    if (initial.length === 0) return summarize(mode, 'empty', initial)
    if (mode === 'snapshot') return summarize(mode, 'snapshot', initial)

    const initialSettled = initial.filter(isSettled)
    if (mode === 'any' && initialSettled.length > 0) {
      return summarize(mode, 'settled', initial)
    }
    if (mode === 'all' && initialSettled.length === initial.length) {
      return summarize(mode, 'all-settled', initial)
    }

    const requested = options.timeoutMs ?? this.defaultWaitMs
    if (!Number.isFinite(requested) || requested < 0) {
      throw new Error('timeoutMs must be a non-negative finite number')
    }
    if (options.signal?.aborted) throw new Error('等待后台任务已取消')
    const timeoutMs = Math.min(requested, this.maxWaitMs)
    const pending = initial.filter((task) => !isSettled(task))

    if (mode === 'all') {
      await Promise.all(
        pending.map((task) =>
          this.runtime.wait(parent, task.taskId, {
            timeoutMs,
            ...(options.signal ? { signal: options.signal } : {})
          })
        )
      )
    } else {
      const controllers = new Map<string, AbortController>()
      const waits = pending.map((task) => {
        const controller = new AbortController()
        controllers.set(task.taskId, controller)
        return this.runtime.wait(parent, task.taskId, {
          timeoutMs,
          signal: controller.signal
        })
      })
      const forwardAbort = (): void => {
        for (const controller of controllers.values()) controller.abort()
      }
      options.signal?.addEventListener('abort', forwardAbort, { once: true })
      try {
        await Promise.race(waits)
      } finally {
        for (const controller of controllers.values()) controller.abort()
        await Promise.allSettled(waits)
        options.signal?.removeEventListener('abort', forwardAbort)
      }
      if (options.signal?.aborted) throw new Error('等待后台任务已取消')
    }

    const latest = this.runtime.list(parent)
    const settled = latest.filter(isSettled).length
    const outcome =
      mode === 'any'
        ? settled > 0
          ? 'settled'
          : 'timeout'
        : settled === latest.length
          ? 'all-settled'
          : 'timeout'
    return summarize(mode, outcome, latest)
  }
}
