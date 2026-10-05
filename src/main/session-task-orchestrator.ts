import { randomUUID } from 'node:crypto'
import type {
  BackgroundSessionHandle,
  BackgroundSessionParent,
  BackgroundSessionResult,
  BackgroundSessionStatus,
  BackgroundSessionWaitOptions,
  BackgroundSessionWaitResult
} from './background-session-service'
import { t } from '../shared/i18n'

export type SessionTaskParent = BackgroundSessionParent

export type SessionTaskRuntime = {
  spawnFromParent(parent: SessionTaskParent, prompt: string): Promise<BackgroundSessionHandle>
  send(handle: BackgroundSessionHandle, prompt: string): Promise<void>
  abort(handle: BackgroundSessionHandle): Promise<void>
  status(handle: BackgroundSessionHandle): BackgroundSessionStatus
  wait?(
    handle: BackgroundSessionHandle,
    options: BackgroundSessionWaitOptions
  ): Promise<BackgroundSessionWaitResult>
  result?(handle: BackgroundSessionHandle): BackgroundSessionResult
}

export type SessionTaskRecord = {
  taskId: string
  parentWorkerId: string
  parentSessionId: string
  parentGeneration: number
  workerId: string
  sessionId: string
  generation: number
  projectPath: string
  createdAt: number
  updatedAt: number
}

export type SessionTaskRelationship = Pick<
  SessionTaskRecord,
  'taskId' | 'parentWorkerId' | 'parentSessionId' | 'parentGeneration' | 'workerId' | 'createdAt'
>

export type SessionTaskView = SessionTaskRecord & {
  state: BackgroundSessionStatus['status'] | 'unavailable'
  busy: boolean
  queuedCount: number
  approvals: number
}

export type SessionTaskWaitOptions = {
  timeoutMs?: number
  signal?: AbortSignal
}

export type SessionTaskWaitResult = {
  outcome: BackgroundSessionWaitResult['outcome']
  task: SessionTaskView
}

export type SessionTaskResult = {
  task: SessionTaskView
  result: BackgroundSessionResult
}

export type SessionTaskSuperviseMode = 'snapshot' | 'any' | 'all'
export type SessionTaskSuperviseOptions = {
  mode?: SessionTaskSuperviseMode
  timeoutMs?: number
  signal?: AbortSignal
}
export type SessionTaskSuperviseOutcome =
  'snapshot' | 'settled' | 'all-settled' | 'timeout' | 'empty'
export type SessionTaskSuperviseResult = {
  mode: SessionTaskSuperviseMode
  outcome: SessionTaskSuperviseOutcome
  tasks: SessionTaskView[]
  settledTaskIds: string[]
  pendingTaskIds: string[]
}

export type SessionTaskCollection = {
  items: SessionTaskResult[]
  readyTaskIds: string[]
  pendingTaskIds: string[]
  attentionTaskIds: string[]
}

export type SessionTaskDelegationItem =
  | { index: number; status: 'spawned'; task: SessionTaskView }
  | { index: number; status: 'failed'; error: string }
export type SessionTaskDelegationResult = {
  items: SessionTaskDelegationItem[]
  spawnedTaskIds: string[]
  failedIndexes: number[]
}

export type SessionTaskOrchestratorOptions = {
  maxWorkersPerParent?: number
  maxWorkersTotal?: number
  defaultWaitMs?: number
  maxWaitMs?: number
  createTaskId?: () => string
  now?: () => number
  onTasksChanged?: () => void
}

const MAX_DELEGATE_BATCH = 4

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message || t('后台任务创建失败')).slice(0, 4096)
}

/**
 * Parent-session-scoped orchestration policy over ordinary background sessions.
 * A worker process is not an authority identity by itself: ownership includes
 * the parent's canonical session id and generation so a later session hosted by
 * the same worker cannot inherit previous task relationships.
 */
export class SessionTaskOrchestrator {
  private readonly tasks = new Map<string, SessionTaskRecord>()
  private readonly maxWorkersPerParent: number
  private readonly maxWorkersTotal: number
  private readonly defaultWaitMs: number
  private readonly maxWaitMs: number
  private readonly createTaskId: () => string
  private readonly now: () => number
  private readonly onTasksChanged: () => void

  constructor(
    private readonly runtime: SessionTaskRuntime,
    options: SessionTaskOrchestratorOptions = {}
  ) {
    this.maxWorkersPerParent = options.maxWorkersPerParent ?? 4
    this.maxWorkersTotal = options.maxWorkersTotal ?? 16
    this.defaultWaitMs = options.defaultWaitMs ?? 25_000
    this.maxWaitMs = options.maxWaitMs ?? 45_000
    this.createTaskId = options.createTaskId ?? randomUUID
    this.now = options.now ?? Date.now
    this.onTasksChanged = options.onTasksChanged ?? (() => undefined)
    if (!Number.isInteger(this.maxWorkersPerParent) || this.maxWorkersPerParent < 1) {
      throw new Error('maxWorkersPerParent must be a positive integer')
    }
    if (
      !Number.isInteger(this.maxWorkersTotal) ||
      this.maxWorkersTotal < this.maxWorkersPerParent
    ) {
      throw new Error('maxWorkersTotal must be an integer at least as large as maxWorkersPerParent')
    }
    if (!Number.isFinite(this.defaultWaitMs) || this.defaultWaitMs < 0) {
      throw new Error('defaultWaitMs must be a non-negative finite number')
    }
    if (!Number.isFinite(this.maxWaitMs) || this.maxWaitMs < this.defaultWaitMs) {
      throw new Error('maxWaitMs must be finite and at least as large as defaultWaitMs')
    }
  }

  async spawn(parent: SessionTaskParent, prompt: string): Promise<SessionTaskView> {
    this.assertParentCanSpawn(parent)
    const parentCount = [...this.tasks.values()].filter((task) =>
      this.sameParent(task, parent)
    ).length
    if (parentCount >= this.maxWorkersPerParent) {
      throw new Error(t('当前父会话的后台任务已达上限'))
    }
    if (this.tasks.size >= this.maxWorkersTotal) {
      throw new Error(t('后台任务总数已达上限'))
    }

    const handle = await this.runtime.spawnFromParent(parent, prompt)
    if ([...this.tasks.values()].some((task) => task.workerId === handle.workerId)) {
      throw new Error(t('后台 worker 已被其他任务占用'))
    }

    const timestamp = this.now()
    const record: SessionTaskRecord = {
      taskId: this.createTaskId(),
      parentWorkerId: parent.workerId,
      parentSessionId: parent.sessionId,
      parentGeneration: parent.generation,
      workerId: handle.workerId,
      sessionId: handle.sessionId,
      generation: handle.generation,
      projectPath: handle.projectPath,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    this.tasks.set(record.taskId, record)
    this.onTasksChanged()
    return this.view(record)
  }

  async delegate(
    parent: SessionTaskParent,
    prompts: readonly string[]
  ): Promise<SessionTaskDelegationResult> {
    if (prompts.length < 1 || prompts.length > MAX_DELEGATE_BATCH) {
      throw new Error(`delegate requires between 1 and ${MAX_DELEGATE_BATCH} tasks`)
    }
    const normalized = prompts.map((prompt) => prompt.trim())
    if (normalized.some((prompt) => !prompt)) throw new Error('delegate tasks cannot be empty')

    const items: SessionTaskDelegationItem[] = []
    for (let index = 0; index < normalized.length; index += 1) {
      try {
        items.push({ index, status: 'spawned', task: await this.spawn(parent, normalized[index]) })
      } catch (error) {
        items.push({ index, status: 'failed', error: safeError(error) })
      }
    }
    return {
      items,
      spawnedTaskIds: items.flatMap((item) =>
        item.status === 'spawned' ? [item.task.taskId] : []
      ),
      failedIndexes: items.flatMap((item) => (item.status === 'failed' ? [item.index] : []))
    }
  }

  async send(parent: SessionTaskParent, taskId: string, prompt: string): Promise<SessionTaskView> {
    const task = this.requireOwned(parent, taskId)
    await this.runtime.send(this.handle(task), prompt)
    task.updatedAt = this.now()
    return this.view(task)
  }

  async cancel(parent: SessionTaskParent, taskId: string): Promise<SessionTaskView> {
    const task = this.requireOwned(parent, taskId)
    await this.runtime.abort(this.handle(task))
    task.updatedAt = this.now()
    return this.view(task)
  }

  async wait(
    parent: SessionTaskParent,
    taskId: string,
    options: SessionTaskWaitOptions = {}
  ): Promise<SessionTaskWaitResult> {
    const task = this.requireOwned(parent, taskId)
    if (!this.runtime.wait) throw new Error(t('后台任务运行时不支持事件等待'))
    const requested = options.timeoutMs ?? this.defaultWaitMs
    if (!Number.isFinite(requested) || requested < 0) {
      throw new Error('timeoutMs must be a non-negative finite number')
    }
    const result = await this.runtime.wait(this.handle(task), {
      timeoutMs: Math.min(requested, this.maxWaitMs),
      ...(options.signal ? { signal: options.signal } : {})
    })
    task.updatedAt = this.now()
    const status = result.status && this.matchesStatus(task, result.status) ? result.status : null
    return {
      outcome: result.outcome === 'unavailable' || !status ? 'unavailable' : result.outcome,
      task: this.viewFromStatus(task, status)
    }
  }

  async supervise(
    parent: SessionTaskParent,
    options: SessionTaskSuperviseOptions = {}
  ): Promise<SessionTaskSuperviseResult> {
    const mode = options.mode ?? 'snapshot'
    const initial = this.list(parent)
    if (!initial.length) return this.superviseSummary(mode, 'empty', initial)
    if (mode === 'snapshot') return this.superviseSummary(mode, 'snapshot', initial)

    const initialSettled = initial.filter((task) => this.isSettled(task))
    if (mode === 'any' && initialSettled.length) {
      return this.superviseSummary(mode, 'settled', initial)
    }
    if (mode === 'all' && initialSettled.length === initial.length) {
      return this.superviseSummary(mode, 'all-settled', initial)
    }

    const requested = options.timeoutMs ?? this.defaultWaitMs
    if (!Number.isFinite(requested) || requested < 0) {
      throw new Error('timeoutMs must be a non-negative finite number')
    }
    if (options.signal?.aborted) throw new Error(t('等待后台任务已取消'))
    const timeoutMs = Math.min(requested, this.maxWaitMs)
    const pending = initial.filter((task) => !this.isSettled(task))

    if (mode === 'all') {
      await Promise.all(
        pending.map((task) =>
          this.wait(parent, task.taskId, {
            timeoutMs,
            ...(options.signal ? { signal: options.signal } : {})
          })
        )
      )
    } else {
      const controllers = pending.map(() => new AbortController())
      const waits = pending.map((task, index) =>
        this.wait(parent, task.taskId, { timeoutMs, signal: controllers[index].signal })
      )
      const forwardAbort = (): void => controllers.forEach((controller) => controller.abort())
      options.signal?.addEventListener('abort', forwardAbort, { once: true })
      if (options.signal?.aborted) forwardAbort()
      try {
        await Promise.race(waits)
      } finally {
        controllers.forEach((controller) => controller.abort())
        await Promise.allSettled(waits)
        options.signal?.removeEventListener('abort', forwardAbort)
      }
      if (options.signal?.aborted) throw new Error(t('等待后台任务已取消'))
    }

    const latest = this.list(parent)
    const settled = latest.filter((task) => this.isSettled(task)).length
    const outcome: SessionTaskSuperviseOutcome =
      mode === 'any'
        ? settled > 0
          ? 'settled'
          : 'timeout'
        : settled === latest.length
          ? 'all-settled'
          : 'timeout'
    return this.superviseSummary(mode, outcome, latest)
  }

  result(parent: SessionTaskParent, taskId: string): SessionTaskResult {
    const task = this.requireOwned(parent, taskId)
    if (!this.runtime.result) throw new Error(t('后台任务运行时不支持 canonical 结果读取'))
    return {
      task: this.view(task),
      result: this.runtime.result(this.handle(task))
    }
  }

  collect(parent: SessionTaskParent): SessionTaskCollection {
    const items = this.list(parent).map((task) => this.result(parent, task.taskId))
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

  status(parent: SessionTaskParent, taskId: string): SessionTaskView {
    return this.view(this.requireOwned(parent, taskId))
  }

  list(parent: SessionTaskParent): SessionTaskView[] {
    return [...this.tasks.values()]
      .filter((task) => this.sameParent(task, parent))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((task) => this.view(task))
  }

  /** Whether this worker runs a background task rather than a conversation the user drives. */
  isTaskWorker(workerId: string): boolean {
    return [...this.tasks.values()].some((task) => task.workerId === workerId)
  }

  relationships(): SessionTaskRelationship[] {
    return [...this.tasks.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(
        ({ taskId, parentWorkerId, parentSessionId, parentGeneration, workerId, createdAt }) => ({
          taskId,
          parentWorkerId,
          parentSessionId,
          parentGeneration,
          workerId,
          createdAt
        })
      )
  }

  /**
   * Drop orchestration ownership when a parent worker disappears or changes
   * native session identity. Child sessions are ordinary resident sessions and
   * deliberately keep running; only the stale parent-child relationship is removed.
   */
  retireParent(
    workerId: string,
    currentIdentity?: { sessionId: string; generation: number }
  ): number {
    const stale = [...this.tasks.values()].filter(
      (task) =>
        task.parentWorkerId === workerId &&
        (!currentIdentity ||
          task.parentSessionId !== currentIdentity.sessionId ||
          task.parentGeneration !== currentIdentity.generation)
    )
    if (!stale.length) return 0
    for (const task of stale) this.tasks.delete(task.taskId)
    this.onTasksChanged()
    return stale.length
  }

  release(parent: SessionTaskParent, taskId: string): void {
    const task = this.requireOwned(parent, taskId)
    const state = this.tryStatus(task)
    if (
      state &&
      (state.busy ||
        state.queuedCount > 0 ||
        state.approvals > 0 ||
        state.status === 'running' ||
        state.status === 'awaiting-approval')
    ) {
      throw new Error(t('后台任务仍在运行或等待处理，不能释放关系'))
    }
    this.tasks.delete(task.taskId)
    this.onTasksChanged()
  }

  private isSettled(task: SessionTaskView): boolean {
    if (task.state === 'unavailable') return true
    if (task.busy || task.queuedCount > 0 || task.approvals > 0) return false
    return task.state === 'idle' || task.state === 'error' || task.state === 'stopped'
  }

  private superviseSummary(
    mode: SessionTaskSuperviseMode,
    outcome: SessionTaskSuperviseOutcome,
    tasks: SessionTaskView[]
  ): SessionTaskSuperviseResult {
    const settledTaskIds = tasks.filter((task) => this.isSettled(task)).map((task) => task.taskId)
    const settled = new Set(settledTaskIds)
    return {
      mode,
      outcome,
      tasks,
      settledTaskIds,
      pendingTaskIds: tasks.filter((task) => !settled.has(task.taskId)).map((task) => task.taskId)
    }
  }

  private assertParentCanSpawn(parent: SessionTaskParent): void {
    if (!parent.workerId || !parent.sessionId || parent.generation < 0) {
      throw new Error(t('父会话不可用'))
    }
    if ([...this.tasks.values()].some((task) => task.workerId === parent.workerId)) {
      throw new Error(t('后台 worker 不能继续创建子 worker'))
    }
  }

  private sameParent(
    task: Pick<SessionTaskRecord, 'parentWorkerId' | 'parentSessionId' | 'parentGeneration'>,
    parent: SessionTaskParent
  ): boolean {
    return (
      task.parentWorkerId === parent.workerId &&
      task.parentSessionId === parent.sessionId &&
      task.parentGeneration === parent.generation
    )
  }

  private requireOwned(parent: SessionTaskParent, taskId: string): SessionTaskRecord {
    const task = this.tasks.get(taskId)
    if (!task || !this.sameParent(task, parent)) {
      throw new Error(t('后台任务不存在或不属于当前父会话'))
    }
    return task
  }

  private handle(task: SessionTaskRecord): BackgroundSessionHandle {
    return {
      workerId: task.workerId,
      sessionId: task.sessionId,
      generation: task.generation,
      projectPath: task.projectPath
    }
  }

  private matchesStatus(task: SessionTaskRecord, status: BackgroundSessionStatus): boolean {
    return (
      status.workerId === task.workerId &&
      status.sessionId === task.sessionId &&
      status.generation === task.generation &&
      status.projectPath === task.projectPath
    )
  }

  private tryStatus(task: SessionTaskRecord): BackgroundSessionStatus | null {
    try {
      const status = this.runtime.status(this.handle(task))
      return this.matchesStatus(task, status) ? status : null
    } catch {
      return null
    }
  }

  private viewFromStatus(
    task: SessionTaskRecord,
    status: BackgroundSessionStatus | null
  ): SessionTaskView {
    return {
      ...task,
      state: status?.status ?? 'unavailable',
      busy: status?.busy ?? false,
      queuedCount: status?.queuedCount ?? 0,
      approvals: status?.approvals ?? 0
    }
  }

  private view(task: SessionTaskRecord): SessionTaskView {
    return this.viewFromStatus(task, this.tryStatus(task))
  }
}
