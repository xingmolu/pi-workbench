import type { ApprovalRequest } from '../shared/contracts'
import { t } from '../shared/i18n'

export const APPROVAL_TIMEOUT_MS = 5 * 60_000

export type ApprovalBlockReason = 'response' | 'timeout' | 'abort' | 'session-switch'

export type ApprovalRegistryChange =
  | { status: 'pending'; request: ApprovalRequest }
  | { status: 'allowed'; request: ApprovalRequest; reason: 'response' }
  | { status: 'blocked'; request: ApprovalRequest; reason: ApprovalBlockReason }

type PendingApproval = {
  request: ApprovalRequest
  resolve: (allow: boolean) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort: () => void
}

export class ApprovalRegistry {
  private readonly pending = new Map<string, PendingApproval>()

  constructor(
    private readonly onChange: (change: ApprovalRegistryChange) => void,
    private readonly timeoutMs = APPROVAL_TIMEOUT_MS
  ) {}

  request(request: ApprovalRequest, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false)
    if (this.pending.has(request.id)) throw new Error(t('重复的审批请求：{id}', { id: request.id }))

    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.finish(request.id, request.generation, false, 'abort')
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => {
        this.finish(request.id, request.generation, false, 'timeout')
      }, this.timeoutMs)
      this.pending.set(request.id, { request, resolve, timer, signal, onAbort })
      this.onChange({ status: 'pending', request })
    })
  }

  requests(generation: number): ApprovalRequest[] {
    return [...this.pending.values()]
      .filter((pending) => pending.request.generation === generation)
      .map((pending) => pending.request)
  }

  resolve(id: string, generation: number, allow: boolean): boolean {
    return this.finish(id, generation, allow, 'response')
  }

  clear(generation: number, reason: 'abort' | 'session-switch'): number {
    const ids = [...this.pending.values()]
      .filter((pending) => pending.request.generation === generation)
      .map((pending) => pending.request.id)
    for (const id of ids) this.finish(id, generation, false, reason)
    return ids.length
  }

  private finish(
    id: string,
    generation: number,
    allow: boolean,
    reason: ApprovalBlockReason
  ): boolean {
    const pending = this.pending.get(id)
    if (!pending || pending.request.generation !== generation) return false

    clearTimeout(pending.timer)
    pending.signal?.removeEventListener('abort', pending.onAbort)
    this.pending.delete(id)
    pending.resolve(allow)
    this.onChange(
      allow
        ? { status: 'allowed', request: pending.request, reason: 'response' }
        : { status: 'blocked', request: pending.request, reason }
    )
    return true
  }
}
