import type { AgentSnapshot } from '../shared/contracts'
import {
  sessionTaskCancelSchema,
  sessionTaskRequestSchema,
  type SessionTaskRequest,
  type SessionTaskResponse,
  type SessionTaskResponseData
} from '../shared/session-task-capability'
import type { SessionTaskCollector } from './session-task-collection'
import type { SessionTaskDelegator } from './session-task-delegation'
import type {
  SessionTaskOrchestrator,
  SessionTaskParent
} from './session-task-orchestrator'
import type { SessionTaskSupervisor } from './session-task-supervision'

export type SessionTaskCapabilityIdentity = Pick<AgentSnapshot, 'sessionId' | 'generation'>

export type SessionTaskCapabilityBrokerOptions = {
  orchestrator: Pick<
    SessionTaskOrchestrator,
    'spawn' | 'send' | 'status' | 'wait' | 'result' | 'cancel' | 'list' | 'release'
  >
  supervisor: Pick<SessionTaskSupervisor, 'supervise'>
  /** Transitional optional seam for tests/adapters; production Main always injects it. */
  collector?: Pick<SessionTaskCollector, 'collect'>
  /** Transitional optional seam for tests/adapters; production Main always injects it. */
  delegator?: Pick<SessionTaskDelegator, 'delegate'>
}

type PendingRequest = {
  workerId: string
  action: SessionTaskRequest['action']
  controller?: AbortController
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message || 'SessionTask 操作失败').slice(0, 4096)
}

function cancellable(action: SessionTaskRequest['action']): boolean {
  return action === 'wait' || action === 'supervise'
}

/**
 * Main-owned authority boundary for Agent-originated SessionTask operations.
 *
 * Worker transport identity is supplied out-of-band by Main. The payload must
 * additionally match the resident worker's canonical session id/generation;
 * only then is it converted into a parent authority for SessionTaskOrchestrator.
 */
export class SessionTaskCapabilityBroker {
  private readonly pending = new Map<string, PendingRequest>()

  constructor(private readonly options: SessionTaskCapabilityBrokerOptions) {}

  handle(
    workerId: string,
    residentIdentity: SessionTaskCapabilityIdentity | null,
    message: unknown,
    reply: (message: SessionTaskResponse) => void
  ): boolean {
    const cancel = sessionTaskCancelSchema.safeParse(message)
    if (cancel.success) {
      const key = this.key(workerId, cancel.data.requestId)
      const pending = this.pending.get(key)
      if (pending?.workerId === workerId && cancellable(pending.action)) {
        pending.controller?.abort()
      }
      return true
    }

    const parsed = sessionTaskRequestSchema.safeParse(message)
    if (!parsed.success) return false
    const request = parsed.data
    const key = this.key(workerId, request.requestId)
    if (this.pending.has(key)) {
      reply({
        type: 'session-task-response',
        requestId: request.requestId,
        ok: false,
        error: '重复的 SessionTask requestId'
      })
      return true
    }

    if (
      !residentIdentity?.sessionId ||
      request.sessionId !== residentIdentity.sessionId ||
      request.generation !== residentIdentity.generation
    ) {
      reply({
        type: 'session-task-response',
        requestId: request.requestId,
        ok: false,
        error: '父会话身份已改变，请重新发起任务操作'
      })
      return true
    }

    const controller = cancellable(request.action) ? new AbortController() : undefined
    this.pending.set(key, {
      workerId,
      action: request.action,
      ...(controller ? { controller } : {})
    })
    const parent: SessionTaskParent = {
      workerId,
      sessionId: request.sessionId,
      generation: request.generation
    }

    void this.execute(parent, request, controller?.signal)
      .then((data) => {
        reply({
          type: 'session-task-response',
          requestId: request.requestId,
          ok: true,
          data
        })
      })
      .catch((error) => {
        reply({
          type: 'session-task-response',
          requestId: request.requestId,
          ok: false,
          error: safeError(error)
        })
      })
      .finally(() => {
        this.pending.delete(key)
      })
    return true
  }

  workerExited(workerId: string): void {
    for (const [key, request] of this.pending) {
      if (request.workerId !== workerId) continue
      request.controller?.abort()
      this.pending.delete(key)
    }
  }

  hasPending(workerId: string): boolean {
    for (const request of this.pending.values()) {
      if (request.workerId === workerId) return true
    }
    return false
  }

  private async execute(
    parent: SessionTaskParent,
    request: SessionTaskRequest,
    signal?: AbortSignal
  ): Promise<SessionTaskResponseData> {
    switch (request.action) {
      case 'spawn':
        return this.options.orchestrator.spawn(parent, request.prompt)
      case 'delegate':
        if (!this.options.delegator) {
          throw new Error('SessionTask 运行时不支持批量委派')
        }
        return this.options.delegator.delegate(parent, request.tasks)
      case 'send':
        return this.options.orchestrator.send(parent, request.taskId, request.prompt)
      case 'status':
        return this.options.orchestrator.status(parent, request.taskId)
      case 'wait':
        return this.options.orchestrator.wait(parent, request.taskId, {
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
          ...(signal ? { signal } : {})
        })
      case 'supervise':
        return this.options.supervisor.supervise(parent, {
          mode: request.mode,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
          ...(signal ? { signal } : {})
        })
      case 'collect':
        if (!this.options.collector) {
          throw new Error('SessionTask 运行时不支持 canonical 结果聚合')
        }
        return this.options.collector.collect(parent)
      case 'result':
        return this.options.orchestrator.result(parent, request.taskId)
      case 'cancel':
        return this.options.orchestrator.cancel(parent, request.taskId)
      case 'list':
        return this.options.orchestrator.list(parent)
      case 'release':
        this.options.orchestrator.release(parent, request.taskId)
        return { released: true }
    }
  }

  private key(workerId: string, requestId: string): string {
    return `${workerId}\0${requestId}`
  }
}
