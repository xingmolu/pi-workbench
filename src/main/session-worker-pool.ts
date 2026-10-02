import { hasActiveNativeSubagents } from '../shared/subagent'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { AgentSnapshot, HostCommand, HostEvent, HostResult } from '../shared/contracts'
import {
  sameSelectedScope,
  type LiveSessionSummary,
  type SelectedSessionScope
} from '../shared/session-runtime'
import { applyStatePatch } from '../shared/state-patch'
import type {
  AgentRuntime,
  AgentRuntimeSession,
  AgentRuntimeSessionOptions,
  PrepareAgentRuntimeSession
} from './agent-runtime'
import { HostRejectedError } from './host-response-broker'
import { t } from '../shared/i18n'

// Compatibility aliases while tests and a few call sites migrate terminology.
export type SessionWorker = AgentRuntimeSession
export type PrepareSessionWorker = PrepareAgentRuntimeSession
export type SessionWorkerFactoryOptions = AgentRuntimeSessionOptions

export type SessionWorkerDiagnostics = Readonly<{
  selectedWorkerId: string | null
  residentSessions: number
  workers: ReadonlyArray<
    Readonly<{
      workerId: string
      pid: number | null
      sessionId: string | null
      generation: number | null
      status: AgentSnapshot['status'] | null
      busy: boolean | null
      residentPendingRequests: number
      runtimePendingRequests: number | null
      disposing: boolean
      exited: boolean | null
    }>
  >
}>

export type BackgroundSessionAdmission = {
  workerId: string
  snapshot: AgentSnapshot
}

type SessionWorkerPoolBaseOptions = {
  capacity?: number
  canonicalize?: (path: string) => Promise<string>
  onEvent?: (workerId: string, event: HostEvent) => void
  onExit?: (workerId: string, error?: Error) => void
  onNeedsSnapshot?: (workerId: string) => void
}

export type SessionWorkerPoolOptions = SessionWorkerPoolBaseOptions &
  (
    | { runtime: AgentRuntime; createWorker?: never }
    | {
        /** @deprecated Migrate callers to AgentRuntime. */
        createWorker(options: SessionWorkerFactoryOptions): Promise<SessionWorker>
        runtime?: never
      }
  )

type Resident = {
  workerId: string
  runtimeId?: string
  cwd: string
  path: string | null
  pathVersion: number
  worker: AgentRuntimeSession
  snapshot: AgentSnapshot | null
  safety: { receipts: 'unknown' | 'pending' | 'settled'; unsaved: boolean }
  unreconciledRequest: boolean
  pending: number
  disposing: boolean
  ended: Promise<never>
  end(error: Error): void
  disposal?: Promise<void>
}

function resolveRuntime(options: SessionWorkerPoolOptions): AgentRuntime {
  if (options.runtime) return options.runtime
  return { createSession: options.createWorker }
}

export class SessionWorkerPool {
  private readonly residents = new Map<string, Resident>()
  private readonly failures = new Map<string, LiveSessionSummary>()
  private selection: SelectedSessionScope | null = null
  private epoch = 0
  private admission: Promise<unknown> = Promise.resolve()
  private admissions = 0
  private closed = false
  private shutdownPromise?: Promise<void>
  private readonly capacity: number
  private readonly runtime: AgentRuntime

  constructor(private readonly options: SessionWorkerPoolOptions) {
    this.capacity = options.capacity ?? 8
    if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > 8)
      throw new Error('Worker capacity must be between 1 and 8')
    this.runtime = resolveRuntime(options)
  }

  getDiagnostics(): SessionWorkerDiagnostics {
    const workers = [...this.residents.values()].map((owner) => {
      const runtime = owner.worker.getDiagnostics?.()
      return {
        workerId: owner.workerId,
        pid: runtime?.pid ?? null,
        sessionId: owner.snapshot?.sessionId ?? null,
        generation: owner.snapshot?.generation ?? null,
        status: owner.snapshot?.status ?? null,
        busy: owner.snapshot?.busy ?? null,
        residentPendingRequests: owner.pending,
        runtimePendingRequests: runtime?.pendingRequests ?? null,
        disposing: owner.disposing || (runtime?.disposing ?? false),
        exited: runtime?.exited ?? null
      }
    })
    return {
      selectedWorkerId: this.selection?.workerId ?? null,
      residentSessions: workers.length,
      workers
    }
  }

  get selectedScope(): SelectedSessionScope | null {
    return this.selection && { ...this.selection }
  }

  get selectionEpoch(): number {
    return this.epoch
  }

  clearSelection(expected: SelectedSessionScope | null): number {
    this.validateSelected(expected)
    this.selection = null
    return ++this.epoch
  }

  /** Hiding navigation must never conceal in-flight work, approval or uncertain receipts. */
  navigationMutationReason(cwd: string, path?: string): string | null {
    if (this.admissions) return t('正在打开会话，请稍后重试')
    for (const owner of this.residents.values()) {
      if (owner.cwd !== cwd || (path && owner.path !== path)) continue
      const s = owner.snapshot
      if (!s || owner.disposing || owner.pending || !s.ready)
        return t('会话正在处理操作，请稍后重试')
      if (
        s.busy ||
        hasActiveNativeSubagents(s) ||
        s.status === 'running' ||
        s.queuedCount ||
        s.followUp.length
      )
        return t('项目仍有运行或排队中的任务，请先停止或等待完成')
      if (s.approvals.length || s.status === 'awaiting-approval')
        return t('项目仍有待确认操作，请先处理')
      if (s.edit?.pending || s.loginPrompt || !['idle', 'success', 'error'].includes(s.login.phase))
        return t('请先完成编辑或登录')
      if (owner.safety.receipts !== 'settled' || owner.unreconciledRequest)
        return t('操作结果尚未确认，请先完成恢复')
    }
    return null
  }

  validateSelected(scope: SelectedSessionScope | null): void {
    if (!sameSelectedScope(scope, this.selection)) throw new Error('Stale selection')
  }

  select(workerId: string, expected?: SelectedSessionScope | null): SelectedSessionScope {
    if (expected !== undefined) this.validateSelected(expected)
    this.resolveOwner(workerId)
    this.selection = { workerId, selectionEpoch: ++this.epoch }
    return { ...this.selection }
  }

  private resolveOwner(workerId: string): Resident {
    const owner = this.residents.get(workerId)
    if (!owner || owner.disposing) throw new Error('Session worker is no longer resident')
    return owner
  }

  open(
    target: { cwd: string; path?: string; runtimeId?: string },
    expected?: SelectedSessionScope | null,
    prepare?: PrepareSessionWorker
  ) {
    return this.enqueueAdmission(() =>
      this.openResident(target, expected, prepare, (owner) => ({
        scope: this.select(owner.workerId, expected),
        snapshot: owner.snapshot!
      }))
    )
  }

  /**
   * Admit or reuse a resident session without changing desktop foreground selection.
   * This is the primitive used by future orchestrators/background agents: residency,
   * capacity and path ownership stay identical to foreground opens, while UI ownership
   * remains entirely unchanged.
   */
  openBackground(
    target: { cwd: string; path?: string; runtimeId?: string },
    prepare?: PrepareSessionWorker
  ): Promise<BackgroundSessionAdmission> {
    return this.enqueueAdmission(() =>
      this.openResident(target, undefined, prepare, (owner) => ({
        workerId: owner.workerId,
        snapshot: owner.snapshot!
      }))
    )
  }

  private enqueueAdmission<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.admissions++
    const admitted = this.admission.then(operation).finally(() => {
      this.admissions--
    })
    this.admission = admitted.catch(() => {})
    return admitted
  }

  private async openResident<Result>(
    target: { cwd: string; path?: string; runtimeId?: string },
    expected: SelectedSessionScope | null | undefined,
    prepare: PrepareSessionWorker | undefined,
    finish: (owner: Resident) => Result
  ): Promise<Result> {
    if (this.closed) throw new Error('Session worker pool is shut down')
    if (expected !== undefined) this.validateSelected(expected)
    const runtimeId =
      this.runtime.resolveProviderId?.(target.runtimeId) ??
      target.runtimeId ??
      this.runtime.provider?.id
    if (
      target.runtimeId &&
      !this.runtime.resolveProviderId &&
      this.runtime.provider?.id !== target.runtimeId
    )
      throw new HostRejectedError('This runtime cannot select another provider')
    const canonicalize = this.options.canonicalize ?? realpath
    const cwd = await canonicalize(target.cwd)
    const path = target.path ? await canonicalize(target.path) : null
    await this.refreshResidentPaths(canonicalize)
    if (this.closed) throw new Error('Session worker pool is shut down')
    if (expected !== undefined) this.validateSelected(expected)
    const existing = path
      ? [...this.residents.values()].find((owner) => owner.path === path)
      : undefined
    if (existing && existing.cwd !== cwd) throw new Error('Session file belongs to another project')
    if (existing && existing.runtimeId !== runtimeId)
      throw new HostRejectedError('Session file belongs to another runtime')
    if (existing?.snapshot) {
      if (prepare) {
        const prepared = await prepare(
          {
            request: (command) => this.requestOwner(existing, command),
            dispose: () => existing.worker.dispose()
          },
          existing.snapshot
        )
        if (prepared) this.acceptSnapshot(existing, prepared)
      }
      return finish(existing)
    }
    if (this.residents.size >= this.capacity) {
      const victim = [...this.residents.values()].find((owner) => this.canEvict(owner))
      if (!victim)
        throw new Error(
          t('常驻会话已达上限，请先结束执行并保存会话后重试；结果未确认的会话需要先结束进程')
        )
      await this.disposeResident(victim)
    }
    const workerId = randomUUID()
    let exited: Error | undefined
    let end!: (error: Error) => void
    const ended = new Promise<never>((_, reject) => {
      end = reject
    })
    void ended.catch(() => {})
    const worker = await this.runtime.createSession({
      workerId,
      cwd,
      ...(runtimeId ? { runtimeId } : {}),
      onEvent: (event) => {
        const owner = this.residents.get(workerId)
        if (!owner || owner.disposing) return
        if (event.event === 'snapshot' && !this.acceptSnapshot(owner, event.data)) return
        if (event.event === 'patch') {
          if (!owner.snapshot) {
            this.options.onNeedsSnapshot?.(workerId)
            return
          }
          const result = applyStatePatch(owner.snapshot, event.data)
          if (result.status === 'needsSnapshot') {
            owner.safety.receipts = 'unknown'
            this.options.onNeedsSnapshot?.(workerId)
            return
          }
          if (result.status === 'ignored') return
          this.acceptSnapshot(owner, result.snapshot)
        }
        this.options.onEvent?.(workerId, event)
      },
      onExit: (error) => {
        if (exited) return
        exited = error ?? new Error('Session worker exited')
        end(exited)
        const failedOwner = this.residents.get(workerId)
        if (failedOwner && !failedOwner.disposing && error) {
          this.failures.set(workerId, {
            workerId,
            ...(failedOwner.runtimeId ? { runtimeId: failedOwner.runtimeId } : {}),
            cwd: failedOwner.cwd,
            sessionPath: failedOwner.path,
            sessionId: failedOwner.snapshot?.sessionId ?? null,
            generation: failedOwner.snapshot?.generation ?? null,
            status: 'error',
            selected: false
          })
          while (this.failures.size > this.capacity)
            this.failures.delete(this.failures.keys().next().value!)
        }
        if (!this.residents.get(workerId)?.disposing) this.residents.delete(workerId)
        if (this.selection?.workerId === workerId) this.selection = null
        this.options.onExit?.(workerId, error)
      }
    })
    if (exited || this.closed) {
      await worker.dispose()
      throw exited ?? new Error('Session worker pool is shut down')
    }
    let claimed = false
    try {
      await this.refreshResidentPaths(canonicalize)
      if (exited || this.closed) throw exited ?? new Error('Session worker pool is shut down')
      if (expected !== undefined) this.validateSelected(expected)
      claimed = path !== null && [...this.residents.values()].some((owner) => owner.path === path)
    } catch (error) {
      await worker.dispose()
      throw error
    }
    if (claimed) {
      await worker.dispose()
      return this.openResident(target, expected, prepare, finish)
    }
    this.residents.set(workerId, {
      workerId,
      ...(runtimeId ? { runtimeId } : {}),
      cwd,
      path,
      pathVersion: 0,
      worker,
      snapshot: null,
      safety: { receipts: 'unknown', unsaved: true },
      unreconciledRequest: false,
      pending: 0,
      disposing: false,
      ended,
      end
    })
    try {
      const result = await this.requestOwner(this.resolveOwner(workerId), {
        type: 'project:navigate',
        cwd,
        sessionId: null,
        generation: 0,
        ...(path ? { sessionPath: path } : {})
      })
      if (result.kind !== 'snapshot') throw new Error('Opening a session requires a snapshot')
      if (prepare) {
        const prepared = await prepare(
          {
            request: (command) => this.requestOwner(this.resolveOwner(workerId), command),
            dispose: () => worker.dispose()
          },
          result.snapshot
        )
        if (prepared) this.acceptSnapshot(this.resolveOwner(workerId), prepared)
      }
      if (path)
        for (const [failedId, failed] of this.failures)
          if (failed.sessionPath === path) this.failures.delete(failedId)
      return finish(this.resolveOwner(workerId))
    } catch (error) {
      const owner = this.residents.get(workerId)
      if (owner) await this.disposeResident(owner)
      throw error
    }
  }

  async request(
    scope: SelectedSessionScope,
    command: HostCommand,
    expectedIdentity?: { sessionId: string | null; generation: number }
  ): Promise<HostResult> {
    if (
      ['session:new', 'session:open', 'project:open', 'project:navigate'].includes(command.type)
    ) {
      throw new Error('Session navigation must use pool.open')
    }
    return this.requestOwner(this.resolveOwner(scope.workerId), command, expectedIdentity)
  }

  private async requestOwner(
    owner: Resident,
    command: HostCommand,
    expectedIdentity?: { sessionId: string | null; generation: number }
  ): Promise<HostResult> {
    owner.pending++
    try {
      const result = await Promise.race([
        owner.worker.request(command, expectedIdentity),
        owner.ended
      ])
      if (result.kind === 'snapshot' || result.kind === 'session-fork')
        this.acceptSnapshot(owner, result.snapshot)
      return result
    } catch (error) {
      if (!(error instanceof HostRejectedError)) {
        owner.unreconciledRequest = true
        owner.safety.receipts = 'unknown'
      }
      throw error
    } finally {
      owner.pending--
    }
  }

  private async refreshResidentPaths(
    canonicalize: (path: string) => Promise<string>
  ): Promise<void> {
    while (true) {
      const captured = [...this.residents.values()].map((owner) => ({
        owner,
        path: owner.path,
        version: owner.pathVersion
      }))
      const paths = await Promise.all(
        captured.map(async ({ path }) => {
          if (!path) return null
          try {
            return await canonicalize(path)
          } catch (error) {
            // A deleted background transcript must not block unrelated navigation.
            // Retain its ownership path; opening that missing file still fails above.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path
            throw error
          }
        })
      )
      if (
        captured.some(
          ({ owner, version }) =>
            owner.pathVersion !== version || this.residents.get(owner.workerId) !== owner
        )
      )
        continue
      captured.forEach(({ owner }, index) => {
        owner.path = paths[index]
      })
      return
    }
  }

  private acceptSnapshot(owner: Resident, snapshot: AgentSnapshot): boolean {
    if (owner.runtimeId && snapshot.runtime && snapshot.runtime.id !== owner.runtimeId)
      throw new Error('Runtime identity changed within a resident session')
    const previous = owner.snapshot
    if (
      previous &&
      (snapshot.generation < previous.generation ||
        (snapshot.generation === previous.generation && snapshot.revision < previous.revision))
    )
      return false
    owner.snapshot = snapshot
    if (owner.path !== snapshot.activeSessionPath) owner.pathVersion++
    owner.path = snapshot.activeSessionPath
    return true
  }

  shutdown(): Promise<void> {
    this.closed = true
    return (this.shutdownPromise ??= (async () => {
      const outcomes = await Promise.allSettled(
        [...this.residents.values()].map((owner) => this.disposeResident(owner))
      )
      await this.admission
      this.selection = null
      this.failures.clear()
      const failure = outcomes.find((outcome) => outcome.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })())
  }

  private disposeResident(owner: Resident): Promise<void> {
    owner.disposing = true
    owner.end(
      new Error(this.closed ? 'Session worker pool is shut down' : 'Session worker disposed')
    )
    return (owner.disposal ??= Promise.resolve()
      .then(() => owner.worker.dispose())
      .then(() => {
        this.residents.delete(owner.workerId)
      }))
  }

  updateSafety(workerId: string, safety: Resident['safety']): void {
    ownerSafeUpdate(this.resolveOwner(workerId), safety)
  }

  private canEvict(owner: Resident): boolean {
    const s = owner.snapshot
    return (
      owner.workerId !== this.selection?.workerId &&
      !owner.disposing &&
      owner.pending === 0 &&
      owner.safety.receipts === 'settled' &&
      !owner.safety.unsaved &&
      !!s?.ready &&
      !!s.activeSessionPath &&
      !s.busy &&
      !hasActiveNativeSubagents(s) &&
      s.status === 'idle' &&
      s.queuedCount === 0 &&
      s.followUp.length === 0 &&
      s.approvals.length === 0 &&
      !s.edit?.pending &&
      !s.loginPrompt &&
      ['idle', 'success', 'error'].includes(s.login.phase)
    )
  }

  getSnapshot(workerId: string): AgentSnapshot | null {
    return this.resolveOwner(workerId).snapshot
  }

  getLiveSummaries(): LiveSessionSummary[] {
    const live: LiveSessionSummary[] = [...this.residents.values()].map((owner) => ({
      workerId: owner.workerId,
      ...(owner.runtimeId ? { runtimeId: owner.runtimeId } : {}),
      cwd: owner.cwd,
      sessionPath: owner.path,
      sessionId: owner.snapshot?.sessionId ?? null,
      generation: owner.snapshot?.generation ?? null,
      status: owner.snapshot?.status ?? 'opening',
      selected: this.selection?.workerId === owner.workerId,
      title: (
        owner.snapshot?.sessions.find((session) => session.path === owner.path)?.title ||
        owner.snapshot?.nodes.find((node) => node.type === 'user')?.text ||
        t('新会话')
      ).slice(0, 200)
    }))
    return [...live, ...[...this.failures.values()].reverse().slice(0, this.capacity - live.length)]
  }

  get quiescent(): boolean {
    return this.quiescentFor()
  }

  quiescentFor(runtimeId?: string): boolean {
    return (
      this.admissions === 0 &&
      [...this.residents.values()]
        .filter((owner) => !runtimeId || owner.runtimeId === runtimeId)
        .every((owner) => {
          const s = owner.snapshot
          return (
            owner.pending === 0 &&
            owner.safety.receipts === 'settled' &&
            !owner.disposing &&
            !!s?.ready &&
            !s.busy &&
            !hasActiveNativeSubagents(s) &&
            !s.queuedCount &&
            !s.followUp.length &&
            !s.approvals.length &&
            !s.edit?.pending &&
            !s.loginPrompt &&
            ['idle', 'success', 'error'].includes(s.login.phase)
          )
        })
    )
  }
}

function ownerSafeUpdate(
  owner: Resident,
  safety: { receipts: 'unknown' | 'pending' | 'settled'; unsaved: boolean }
): void {
  // An idle projection is not a completion receipt for a timed-out command.
  // Keep uncertain ownership until this process exits; ordinary snapshots and
  // attachment reconciliation cannot certify a different outstanding request.
  owner.safety = { ...safety, receipts: owner.unreconciledRequest ? 'unknown' : safety.receipts }
}
