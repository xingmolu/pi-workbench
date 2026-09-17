import { randomUUID } from 'node:crypto'
import type {
  BackgroundSessionHandle,
  BackgroundSessionStatus
} from './background-session-service'

export type SessionTaskRuntime = {
  spawnFromParent(parentWorkerId: string, prompt: string): Promise<BackgroundSessionHandle>
  send(handle: BackgroundSessionHandle, prompt: string): Promise<void>
  abort(handle: BackgroundSessionHandle): Promise<void>
  status(handle: BackgroundSessionHandle): BackgroundSessionStatus
}

export type SessionTaskRecord = {
  taskId: string
  parentWorkerId: string
  workerId: string
  sessionId: string
  generation: number
  projectPath: string
  createdAt: number
  updatedAt: number
}

export type SessionTaskView = SessionTaskRecord & {
  state: BackgroundSessionStatus['status'] | 'unavailable'
  busy: boolean
  queuedCount: number
  approvals: number
}

export type SessionTaskOrchestratorOptions = {
  maxWorkersPerParent?: number
  maxWorkersTotal?: number
  createTaskId?: () => string
  now?: () => number
}

/**
 * Parent-scoped orchestration policy over ordinary background sessions.
 *
 * This class owns only task relationships and bounded policy. It never owns a
 * transcript, Agent runtime, process or second session store. Worker sessions
 * remain normal Pi sessions managed by SessionWorkerSupervisor/AgentRuntime.
 */
export class SessionTaskOrchestrator {
  private readonly tasks = new Map<string, SessionTaskRecord>()
  private readonly maxWorkersPerParent: number
  private readonly maxWorkersTotal: number
  private readonly createTaskId: () => string
  private readonly now: () => number

  constructor(
    private readonly runtime: SessionTaskRuntime,
    options: SessionTaskOrchestratorOptions = {}
  ) {
    this.maxWorkersPerParent = options.maxWorkersPerParent ?? 4
    this.maxWorkersTotal = options.maxWorkersTotal ?? 16
    this.createTaskId = options.createTaskId ?? randomUUID
    this.now = options.now ?? Date.now
    if (!Number.isInteger(this.maxWorkersPerParent) || this.maxWorkersPerParent < 1) {
      throw new Error('maxWorkersPerParent must be a positive integer')
    }
    if (
      !Number.isInteger(this.maxWorkersTotal) ||
      this.maxWorkersTotal < this.maxWorkersPerParent
    ) {
      throw new Error('maxWorkersTotal must be an integer at least as large as maxWorkersPerParent')
    }
  }

  async spawn(parentWorkerId: string, prompt: string): Promise<SessionTaskView> {
    this.assertParentCanSpawn(parentWorkerId)
    const parentCount = [...this.tasks.values()].filter(
      (task) => task.parentWorkerId === parentWorkerId
    ).length
    if (parentCount >= this.maxWorkersPerParent) {
      throw new Error('当前父会话的后台任务已达上限')
    }
    if (this.tasks.size >= this.maxWorkersTotal) {
      throw new Error('后台任务总数已达上限')
    }

    const handle = await this.runtime.spawnFromParent(parentWorkerId, prompt)
    if ([...this.tasks.values()].some((task) => task.workerId === handle.workerId)) {
      throw new Error('后台 worker 已被其他任务占用')
    }

    const timestamp = this.now()
    const record: SessionTaskRecord = {
      taskId: this.createTaskId(),
      parentWorkerId,
      workerId: handle.workerId,
      sessionId: handle.sessionId,
      generation: handle.generation,
      projectPath: handle.projectPath,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    this.tasks.set(record.taskId, record)
    return this.view(record)
  }

  async send(parentWorkerId: string, taskId: string, prompt: string): Promise<SessionTaskView> {
    const task = this.requireOwned(parentWorkerId, taskId)
    await this.runtime.send(this.handle(task), prompt)
    task.updatedAt = this.now()
    return this.view(task)
  }

  async cancel(parentWorkerId: string, taskId: string): Promise<SessionTaskView> {
    const task = this.requireOwned(parentWorkerId, taskId)
    await this.runtime.abort(this.handle(task))
    task.updatedAt = this.now()
    return this.view(task)
  }

  status(parentWorkerId: string, taskId: string): SessionTaskView {
    return this.view(this.requireOwned(parentWorkerId, taskId))
  }

  list(parentWorkerId: string): SessionTaskView[] {
    return [...this.tasks.values()]
      .filter((task) => task.parentWorkerId === parentWorkerId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((task) => this.view(task))
  }

  /**
   * Forget only the orchestration relationship. The normal worker session is
   * never deleted. Running/queued/approval work must settle or be cancelled first.
   */
  release(parentWorkerId: string, taskId: string): void {
    const task = this.requireOwned(parentWorkerId, taskId)
    const state = this.tryStatus(task)
    if (
      state &&
      (state.busy ||
        state.queuedCount > 0 ||
        state.approvals > 0 ||
        state.status === 'running' ||
        state.status === 'awaiting-approval')
    ) {
      throw new Error('后台任务仍在运行或等待处理，不能释放关系')
    }
    this.tasks.delete(task.taskId)
  }

  private assertParentCanSpawn(parentWorkerId: string): void {
    if (!parentWorkerId) throw new Error('父会话不可用')
    if ([...this.tasks.values()].some((task) => task.workerId === parentWorkerId)) {
      throw new Error('后台 worker 不能继续创建子 worker')
    }
  }

  private requireOwned(parentWorkerId: string, taskId: string): SessionTaskRecord {
    const task = this.tasks.get(taskId)
    if (!task || task.parentWorkerId !== parentWorkerId) {
      throw new Error('后台任务不存在或不属于当前父会话')
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

  private tryStatus(task: SessionTaskRecord): BackgroundSessionStatus | null {
    try {
      return this.runtime.status(this.handle(task))
    } catch {
      return null
    }
  }

  private view(task: SessionTaskRecord): SessionTaskView {
    const status = this.tryStatus(task)
    return {
      ...task,
      state: status?.status ?? 'unavailable',
      busy: status?.busy ?? false,
      queuedCount: status?.queuedCount ?? 0,
      approvals: status?.approvals ?? 0
    }
  }
}
