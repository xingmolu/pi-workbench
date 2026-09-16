import { randomUUID } from 'node:crypto'
import type { HostCommand, HostEvent, HostRequest, HostResult } from '../shared/contracts'
import { hostResultMatchesCommand } from '../shared/command-result'
import { hostMessageSchema } from '../shared/schemas'

type PendingRequest = {
  command: HostCommand
  resolve: (result: HostResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type HostResponseBrokerOptions = {
  timeoutMs?: number
  createRequestId?: () => string
  onInvalid?: (message: string) => void
}

/** A validated failure response is a completion receipt, unlike a lost response. */
export class HostRejectedError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export class HostResponseBroker {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly timeoutMs: number
  private readonly createRequestId: () => string
  private readonly onInvalid: (message: string) => void

  constructor(options: HostResponseBrokerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.createRequestId = options.createRequestId ?? randomUUID
    this.onInvalid = options.onInvalid ?? (() => undefined)
  }

  get pendingCount(): number {
    return this.pending.size
  }

  request(command: HostCommand, dispatch: (request: HostRequest) => void, expectedIdentity?: HostRequest['expectedIdentity']): Promise<HostResult> {
    const requestId = this.createRequestId()
    const request: HostRequest = { ...command, requestId, ...(expectedIdentity ? { expectedIdentity } : {}) }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Agent Host 请求超时：${command.type}`))
      }, this.timeoutMs)
      this.pending.set(requestId, { command, resolve, reject, timer })
      try {
        dispatch(request)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  accept(message: unknown): HostEvent | null {
    const parsed = hostMessageSchema.safeParse(message)
    if (!parsed.success) {
      this.onInvalid(parsed.error.message)
      if (
        isRecord(message) &&
        message.type === 'response' &&
        typeof message.requestId === 'string'
      ) {
        this.rejectPending(message.requestId, new Error('Agent Host 返回无效响应'))
      }
      return null
    }

    const value = parsed.data
    if (value.type === 'event') return value
    const pending = this.takePending(value.requestId)
    if (!pending) return null

    if (!value.ok) {
      pending.reject(new HostRejectedError(value.error))
    } else if (!hostResultMatchesCommand(pending.command, value.data)) {
      pending.reject(new Error(`Agent Host 响应类型不匹配：${pending.command.type}`))
    } else {
      pending.resolve(value.data)
    }
    return null
  }

  rejectAll(error: Error): void {
    for (const requestId of [...this.pending.keys()]) this.rejectPending(requestId, error)
  }

  private takePending(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId)
    if (!pending) return undefined
    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    return pending
  }

  private rejectPending(requestId: string, error: Error): boolean {
    const pending = this.takePending(requestId)
    if (!pending) return false
    pending.reject(error)
    return true
  }
}
