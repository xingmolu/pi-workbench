import type { AgentSnapshot, DesktopEvent, HostCommand, HostResult } from '../shared/contracts'
import type { DesktopCommandOrigin, SelectedSessionScope } from '../shared/session-runtime'
import { SessionWorkerPool, type SessionWorkerPoolOptions } from './session-worker-pool'

/** Captures desktop ownership before asynchronous work; native identity stays worker-local. */
export class SessionWorkerController {
  readonly pool: SessionWorkerPool
  private lastForeground: AgentSnapshot | null = null
  constructor(
    private readonly options: Omit<SessionWorkerPoolOptions, 'onEvent'> & {
      publish(event: DesktopEvent): void
      selected(snapshot: AgentSnapshot): void
      receiptsSettled?(workerId: string, snapshot: AgentSnapshot): boolean
      onWorkerEvent?(workerId: string, snapshot: AgentSnapshot | null): void
    }
  ) {
    this.pool = new SessionWorkerPool({
      ...options,
      onEvent: (workerId, event) => {
        const snapshot = this.pool.getSnapshot(workerId)
        if (snapshot && options.receiptsSettled)
          this.pool.updateSafety(workerId, {
            receipts: options.receiptsSettled(workerId, snapshot) ? 'settled' : 'pending',
            unsaved: !snapshot.activeSessionPath
          })
        const scope = this.pool.selectedScope
        if (scope?.workerId === workerId) {
          if (snapshot) this.lastForeground = { ...snapshot, desktopScope: scope }
          if (event.event === 'snapshot') this.publish(event.data, scope)
          else if (event.event === 'patch')
            options.publish({
              ...event,
              data: { ...event.data, meta: { ...event.data.meta, desktopScope: scope } }
            })
          else options.publish(event)
        }
        this.summaries()
        options.onWorkerEvent?.(workerId, snapshot)
      }
    })
  }

  capture(origin?: DesktopCommandOrigin): SelectedSessionScope | null {
    const scope = this.pool.selectedScope
    if (origin) {
      this.pool.validateSelected(origin.scope)
      const snapshot = this.pool.getSnapshot(origin.scope.workerId)
      if (
        !snapshot ||
        snapshot.sessionId !== origin.sessionId ||
        snapshot.generation !== origin.generation
      )
        throw new Error('会话已改变，请刷新后重试')
    }
    return scope
  }

  captureNavigation(origin?: DesktopCommandOrigin): SelectedSessionScope | null {
    const previous = this.lastForeground
    if (
      origin &&
      !this.pool.selectedScope &&
      previous?.desktopScope &&
      previous.desktopScope.workerId === origin.scope.workerId &&
      previous.desktopScope.selectionEpoch === origin.scope.selectionEpoch &&
      previous.sessionId === origin.sessionId &&
      previous.generation === origin.generation
    )
      return null
    return this.capture(origin)
  }

  async request(command: HostCommand, origin?: DesktopCommandOrigin): Promise<HostResult> {
    const scope = this.capture(origin)
    if (!scope) throw new Error('请先打开会话')
    const snapshot = this.pool.getSnapshot(scope.workerId)
    const expectedIdentity =
      origin ??
      (snapshot ? { sessionId: snapshot.sessionId, generation: snapshot.generation } : undefined)
    const result = await this.pool.request(
      scope,
      command,
      expectedIdentity && {
        sessionId: expectedIdentity.sessionId,
        generation: expectedIdentity.generation
      }
    )
    if (result.kind === 'snapshot' || result.kind === 'session-fork')
      return { ...result, snapshot: { ...result.snapshot, desktopScope: scope } }
    return result
  }

  async open(
    target: { cwd: string; path?: string },
    expected: SelectedSessionScope | null,
    model?: { providerId: string; modelId: string },
    origin?: DesktopCommandOrigin
  ): Promise<AgentSnapshot> {
    this.captureNavigation(origin)
    const result = await this.pool.open(target, expected, async (worker) => {
      if (!target.path && model) await worker.request({ type: 'model:set', ...model })
      const state = await worker.request({ type: 'state:get' })
      if (state.kind !== 'snapshot') throw new Error('会话状态不可用')
      this.captureNavigation(origin)
      return state.snapshot
    })
    return this.publish(result.snapshot, result.scope)
  }

  select(workerId: string, origin?: DesktopCommandOrigin): AgentSnapshot {
    const expected = this.captureNavigation(origin)
    const snapshot = this.pool.getSnapshot(workerId)
    if (!snapshot) throw new Error('会话尚未就绪')
    const scope = this.pool.select(workerId, expected)
    return this.publish(snapshot, scope)
  }

  private publish(snapshot: AgentSnapshot, scope: SelectedSessionScope): AgentSnapshot {
    const decorated = { ...snapshot, desktopScope: scope }
    this.lastForeground = decorated
    this.options.selected(decorated)
    this.options.publish({ type: 'event', event: 'snapshot', data: decorated })
    this.summaries()
    return decorated
  }

  summaries(): void {
    this.options.publish({ type: 'event', event: 'sessions', data: this.pool.getLiveSummaries() })
  }
}
