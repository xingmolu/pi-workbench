import { randomUUID } from 'node:crypto'
import {
  sessionTaskResponseSchema,
  type SessionTaskRequest,
  type SessionTaskResponseData
} from '../shared/session-task-capability'

export type SessionTaskOperation =
  | { action: 'spawn'; prompt: string }
  | { action: 'send'; taskId: string; prompt: string }
  | { action: 'status'; taskId: string }
  | { action: 'wait'; taskId: string; timeoutMs?: number }
  | { action: 'result'; taskId: string }
  | { action: 'cancel'; taskId: string }
  | { action: 'list' }
  | { action: 'release'; taskId: string }

export type SessionTaskCapabilityClientOptions = {
  send(message: unknown): void
  identity(): { sessionId: string | null; generation: number }
  createRequestId?: () => string
}

type Pending = {
  action: SessionTaskOperation['action']
  resolve(data: SessionTaskResponseData): void
  reject(error: Error): void
}

/** Thin Agent Host client for the Main-owned SessionTask capability. */
export class SessionTaskCapabilityClient {
  private readonly pending = new Map<string, Pending>()
  private readonly createRequestId: () => string

  constructor(private readonly options: SessionTaskCapabilityClientOptions) {
    this.createRequestId = options.createRequestId ?? randomUUID
  }

  request(operation: SessionTaskOperation, signal?: AbortSignal): Promise<SessionTaskResponseData> {
    if (signal?.aborted) return Promise.reject(new Error('SessionTask 操作已取消'))
    const identity = this.options.identity()
    if (!identity.sessionId) return Promise.reject(new Error('当前会话尚未建立稳定身份'))
    const requestId = this.createRequestId()
    if (this.pending.has(requestId)) return Promise.reject(new Error('SessionTask requestId 冲突'))

    return new Promise<SessionTaskResponseData>((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort)
        this.pending.delete(requestId)
      }
      const finishResolve = (data: SessionTaskResponseData): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(data)
      }
      const finishReject = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onAbort = (): void => {
        if (operation.action === 'wait') {
          this.safeCancel(requestId)
          finishReject(new Error('等待后台任务已取消'))
        } else {
          finishReject(
            new Error('SessionTask 操作响应未知；操作可能已执行，请使用 list/status 核对')
          )
        }
      }
      const pending: Pending = {
        action: operation.action,
        resolve: finishResolve,
        reject: finishReject
      }
      this.pending.set(requestId, pending)
      signal?.addEventListener('abort', onAbort, { once: true })

      const request: SessionTaskRequest = {
        type: 'session-task-request',
        requestId,
        sessionId: identity.sessionId,
        generation: identity.generation,
        ...operation
      } as SessionTaskRequest
      try {
        this.options.send(request)
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  accept(message: unknown): boolean {
    const parsed = sessionTaskResponseSchema.safeParse(message)
    if (!parsed.success) return false
    const response = parsed.data
    const pending = this.pending.get(response.requestId)
    if (!pending) return true
    if (response.ok) pending.resolve(response.data)
    else pending.reject(new Error(response.error))
    return true
  }

  rejectAll(reason: string): void {
    const error = new Error(reason)
    for (const [requestId, pending] of [...this.pending]) {
      if (pending.action === 'wait') this.safeCancel(requestId)
      pending.reject(error)
    }
  }

  private safeCancel(requestId: string): void {
    try {
      this.options.send({ type: 'session-task-cancel', requestId })
    } catch {
      // Local teardown still rejects the waiter; Main also clears waits on worker exit.
    }
  }

  get pendingCount(): number {
    return this.pending.size
  }
}
