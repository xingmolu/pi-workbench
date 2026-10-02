import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  browserCapabilityRequestSchema,
  browserCapabilityCancelSchema,
  computerUseCapabilityRequestSchema,
  computerUseCapabilityCancelSchema
} from '../shared/schemas'
import type { SelectedSessionScope } from '../shared/session-runtime'
import {
  CapabilityBroker,
  type ForegroundCapabilityToken,
  type SessionCapabilityIdentity
} from './capability-broker'
import { t } from '../shared/i18n'

const requests = z.union([browserCapabilityRequestSchema, computerUseCapabilityRequestSchema])
const cancellations = z.union([browserCapabilityCancelSchema, computerUseCapabilityCancelSchema])
export type ForegroundCapabilityRequest = z.infer<typeof requests>
type Authority = {
  selected: SelectedSessionScope | null
  identity: SessionCapabilityIdentity | null
  /** The owner's session is running a task (including one waiting on an approval). */
  running?: boolean
}
/**
 * Desktop control follows the task, not the sidebar: a session driven from the phone or
 * left running in the background keeps the desktop until its task ends. One session at a
 * time; the lease is identity-bound like foreground tokens.
 */
type DesktopLease = SessionCapabilityIdentity & { kind: 'desktop'; workerId: string }
type Scope = ForegroundCapabilityToken | DesktopLease
type Pending = { owner: string; cancel(): void }

/** One owner is one runtime channel incarnation. Replies never resolve a mutable current host. */
export class ForegroundCapabilityRouter {
  private readonly broker = new CapabilityBroker()
  private readonly pending = new Map<string, Pending>()
  private readonly scopes = new Map<string, Scope>()
  private desktopHolder: string | null = null

  constructor(
    private readonly deps: {
      authority(owner: string): Authority
      execute(
        request: ForegroundCapabilityRequest,
        owner: string,
        executionId: string,
        signal: AbortSignal
      ): Promise<unknown>
      abortBrowser(executionId: string): void
      releaseOwner(owner: string): void
    }
  ) {}

  handle(owner: string, message: unknown, reply: (response: unknown) => void): boolean {
    const cancel = cancellations.safeParse(message)
    if (cancel.success) {
      this.pending.get(this.key(owner, cancel.data.capability, cancel.data.requestId))?.cancel()
      return true
    }
    const parsed = requests.safeParse(message)
    if (!parsed.success) return false
    const request = parsed.data
    this.invalidate()
    const authority = this.deps.authority(owner)
    const busyHolder = request.capability === 'computer-use' ? this.otherDesktopHolder(owner) : null
    const token: Scope | null =
      request.capability === 'computer-use'
        ? busyHolder || !this.sameIdentity(authority.identity, request)
          ? null
          : authority.running || authority.selected?.workerId === owner
            ? {
                kind: 'desktop',
                workerId: owner,
                sessionId: request.sessionId,
                generation: request.generation
              }
            : null
        : this.broker.captureForeground(owner, request, authority.selected, authority.identity)
    const key = this.key(owner, request.capability, request.requestId)
    const respond = (ok: boolean, data?: unknown, error?: string): void => {
      // A dead channel must not turn lifecycle cleanup into an unhandled rejection.
      try {
        reply({
          type: 'capability-response',
          capability: request.capability,
          requestId: request.requestId,
          ok,
          ...(ok ? { data } : { error })
        })
      } catch {
        /* Owner channel has exited. */
      }
    }
    if (!token || this.pending.has(key)) {
      respond(
        false,
        undefined,
        busyHolder
          ? t(
              '另一个会话正在控制桌面，操作已取消。请等它的任务结束或让用户停止它后再试，不要反复重试。'
            )
          : !token
            ? request.capability === 'browser'
              ? t(
                  '当前会话未选中，操作已取消：浏览器只能由 Pi Desktop 窗口里正在显示的会话使用。请让用户在 Pi Desktop 中切回这个会话后再试，不要反复重试。'
                )
              : t('当前会话已切换或已结束，桌面控制已取消。')
            : t('当前会话未选中或请求已过期，操作已取消')
      )
      return true
    }
    this.scopes.set(owner, token)
    if ('kind' in token) this.desktopHolder = owner
    const controller = new AbortController()
    const executionId = randomUUID()
    let settled = false
    const finish = (ok: boolean, data?: unknown, error?: string): void => {
      if (settled) return
      settled = true
      this.pending.delete(key)
      respond(ok, data, error)
    }
    const pending: Pending = {
      owner,
      cancel: () => {
        if (settled) return
        // Settle before invoking services: abort callbacks may reenter the router.
        finish(false, undefined, t('会话操作已停止或前台已切换'))
        controller.abort()
        if (request.capability === 'browser') this.deps.abortBrowser(executionId)
      }
    }
    this.pending.set(key, pending)
    try {
      void this.deps.execute(request, owner, executionId, controller.signal).then(
        (data) => {
          this.invalidate()
          if (!this.valid(token)) pending.cancel()
          else finish(true, data)
        },
        (error) => finish(false, undefined, error instanceof Error ? error.message : String(error))
      )
    } catch (error) {
      finish(false, undefined, error instanceof Error ? error.message : String(error))
    }
    return true
  }

  private key(owner: string, capability: string, requestId: string): string {
    return JSON.stringify([owner, capability, requestId])
  }

  private sameIdentity(
    identity: SessionCapabilityIdentity | null,
    request: SessionCapabilityIdentity
  ): boolean {
    return Boolean(
      identity &&
      identity.sessionId === request.sessionId &&
      identity.generation === request.generation
    )
  }

  /** A holder whose task ended, or whose session changed, no longer blocks others. */
  private otherDesktopHolder(owner: string): string | null {
    const holder = this.desktopHolder
    if (!holder || holder === owner) return null
    const scope = this.scopes.get(holder)
    const authority = this.deps.authority(holder)
    if (scope && this.valid(scope) && (authority.running || this.hasPending(holder))) return holder
    this.desktopHolder = null
    return null
  }

  private hasPending(owner: string): boolean {
    for (const entry of this.pending.values()) if (entry.owner === owner) return true
    return false
  }

  private valid(token: Scope): boolean {
    const authority = this.deps.authority(token.workerId)
    if ('kind' in token)
      return this.desktopHolder === token.workerId && this.sameIdentity(authority.identity, token)
    return this.broker.retainsForeground(token, authority.selected, authority.identity)
  }

  invalidate(): void {
    for (const [owner, token] of this.scopes) if (!this.valid(token)) this.cancelOwner(owner)
  }

  cancelOwner(owner: string): void {
    for (const entry of this.pending.values()) if (entry.owner === owner) entry.cancel()
    if (this.desktopHolder === owner) this.desktopHolder = null
    if (this.scopes.delete(owner)) this.deps.releaseOwner(owner)
  }

  cancelAll(): void {
    for (const owner of this.scopes.keys()) this.cancelOwner(owner)
  }

  /** Admitted requests awaiting a reply, not native work that may ignore abort. */
  get pendingCount(): number {
    return this.pending.size
  }
}
