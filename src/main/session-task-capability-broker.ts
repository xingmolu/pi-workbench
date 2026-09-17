import type { AgentSnapshot } from '../shared/contracts'
import {
  sessionTaskCancelSchema,
  sessionTaskRequestSchema,
  type SessionTaskRequest,
  type SessionTaskResponse,
  type SessionTaskResponseData
} from '../shared/session-task-capability'
import type {
  SessionTaskOrchestrator,
  SessionTaskParent
} from './session-task-orchestrator'

export type SessionTaskCapabilityIdentity = Pick<AgentSnapshot, 'sessionId' | 'generation'>

export type SessionTaskCapabilityRuntime = Pick<
  SessionTaskOrchestrator,
  'delegate' | 'send' | 'supervise' | 'collect' | 'cancel' | 'release'
>

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
  return action === 'supervise'
}

/** Main-owned authority boundary for Agent-originated SessionTask operations. */
export class SessionTaskCapabilityBroker {
  private readonly pending = new Map<string, PendingRequest>()

  constructor(private readonly runtime: SessionTaskCapabilityRuntime) {}

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
      if (pending?.workerId === workerId && cancellable(pending.action)) pending.controller?.abort()
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
      .then((data) =>
        reply({ type: 'session-task-response', requestId: request.requestId, ok: true, data })
      )
      .catch((error) =>
        reply({
          type: 'session-task-response',
          requestId: request.requestId,
          ok: false,
          error: safeError(error)
        })
      )
      .finally(() => this.pending.delete(key))
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
      case 'delegate':
        return this.runtime.delegate(parent, request.tasks)
      case 'send':
        return this.runtime.send(parent, request.taskId, request.prompt)
      case 'supervise':
        return this.runtime.supervise(parent, {
          mode: request.mode,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
          ...(signal ? { signal } : {})
        })
      case 'collect':
        return this.runtime.collect(parent)
      case 'cancel':
        return this.runtime.cancel(parent, request.taskId)
      case 'release':
        this.runtime.release(parent, request.taskId)
        return { released: true }
    }
  }

  private key(workerId: string, requestId: string): string {
    return `${workerId}\0${requestId}`
  }
}
