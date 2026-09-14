import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { AgentSnapshot, HostCommand, HostEvent, HostResult } from '../shared/contracts'
import {
  sameSelectedScope,
  type LiveSessionSummary,
  type SelectedSessionScope
} from '../shared/session-runtime'
import { applyStatePatch } from '../shared/state-patch'

export type SessionWorker = {
  request(command: HostCommand): Promise<HostResult>
  /** Resolves only after the worker has stopped and cannot execute further work. */
  dispose(): Promise<void>
}
export type SessionWorkerFactoryOptions = {
  workerId: string
  cwd: string
  onEvent(event: HostEvent): void
  onExit(error?: Error): void
}
export type SessionWorkerPoolOptions = {
  capacity?: number
  canonicalize?: (path: string) => Promise<string>
  createWorker(options: SessionWorkerFactoryOptions): Promise<SessionWorker>
  onEvent?: (workerId: string, event: HostEvent) => void
  onExit?: (workerId: string, error?: Error) => void
  onNeedsSnapshot?: (workerId: string) => void
}
type Resident = {
  workerId: string
  cwd: string
  path: string | null
  pathVersion: number
  worker: SessionWorker
  snapshot: AgentSnapshot | null
  safety: { receipts: 'unknown' | 'pending' | 'settled'; unsaved: boolean }
  pending: number
  disposing: boolean
  ended: Promise<never>
  end(error: Error): void
  disposal?: Promise<void>
}

export class SessionWorkerPool {
  private readonly residents = new Map<string, Resident>()
  private selection: SelectedSessionScope | null = null
  private epoch = 0
  private admission: Promise<unknown> = Promise.resolve()
  private closed = false
  private shutdownPromise?: Promise<void>
  private readonly capacity: number
  constructor(private readonly options: SessionWorkerPoolOptions) {
    this.capacity = options.capacity ?? 8
    if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > 8)
      throw new Error('Worker capacity must be between 1 and 8')
  }

  get selectedScope(): SelectedSessionScope | null {
    return this.selection && { ...this.selection }
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

  open(target: { cwd: string; path?: string }, expected?: SelectedSessionScope | null) {
    const operation = this.admission.then(() => this.openResident(target, expected))
    this.admission = operation.catch(() => {})
    return operation
  }

  private async openResident(
    target: { cwd: string; path?: string },
    expected?: SelectedSessionScope | null
  ) {
    if (this.closed) throw new Error('Session worker pool is shut down')
    if (expected !== undefined) this.validateSelected(expected)
    const canonicalize = this.options.canonicalize ?? realpath
    const cwd = await canonicalize(target.cwd)
    const path = target.path ? await canonicalize(target.path) : null
    // Resolve a consistent set: any owner can fork while another path is resolving.
    while (true) {
      const captured = [...this.residents.values()].map((owner) => ({
        owner,
        path: owner.path,
        version: owner.pathVersion
      }))
      const paths = await Promise.all(
        captured.map(({ path }) => (path ? canonicalize(path) : null))
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
      break
    }
    if (this.closed) throw new Error('Session worker pool is shut down')
    if (expected !== undefined) this.validateSelected(expected)
    const existing = path
      ? [...this.residents.values()].find((owner) => owner.path === path)
      : undefined
    if (existing && existing.cwd !== cwd) throw new Error('Session file belongs to another project')
    if (existing?.snapshot)
      return { scope: this.select(existing.workerId, expected), snapshot: existing.snapshot }
    if (this.residents.size >= this.capacity) {
      const victim = [...this.residents.values()].find((owner) => this.canEvict(owner))
      if (!victim)
        throw new Error('Session worker capacity reached; no safe resident can be evicted')
      await this.disposeResident(victim)
    }
    const workerId = randomUUID()
    let exited: Error | undefined
    let end!: (error: Error) => void
    const ended = new Promise<never>((_, reject) => {
      end = reject
    })
    void ended.catch(() => {})
    const worker = await this.options.createWorker({
      workerId,
      cwd,
      onEvent: (event) => {
        const owner = this.residents.get(workerId)
        if (!owner) return
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
        if (!this.residents.get(workerId)?.disposing) this.residents.delete(workerId)
        if (this.selection?.workerId === workerId) this.selection = null
        this.options.onExit?.(workerId, error)
      }
    })
    if (exited || this.closed) {
      await worker.dispose()
      throw exited ?? new Error('Session worker pool is shut down')
    }
    this.residents.set(workerId, {
      workerId,
      cwd,
      path,
      pathVersion: 0,
      worker,
      snapshot: null,
      safety: { receipts: 'unknown', unsaved: true },
      pending: 0,
      disposing: false,
      ended,
      end
    })
    try {
      const result = await this.request(
        { workerId, selectionEpoch: 0 },
        {
          type: 'project:navigate',
          cwd,
          sessionId: null,
          generation: 0,
          ...(path ? { sessionPath: path } : {})
        }
      )
      if (result.kind !== 'snapshot') throw new Error('Opening a session requires a snapshot')
      return {
        scope: this.select(workerId, expected),
        snapshot: this.resolveOwner(workerId).snapshot!
      }
    } catch (error) {
      const owner = this.residents.get(workerId)
      if (owner) await this.disposeResident(owner)
      throw error
    }
  }

  async request(scope: SelectedSessionScope, command: HostCommand): Promise<HostResult> {
    const owner = this.resolveOwner(scope.workerId)
    owner.pending++
    try {
      const result = await Promise.race([owner.worker.request(command), owner.ended])
      if (result.kind === 'snapshot' || result.kind === 'session-fork')
        this.acceptSnapshot(owner, result.snapshot)
      return result
    } catch (error) {
      owner.safety.receipts = 'unknown'
      throw error
    } finally {
      owner.pending--
    }
  }

  private acceptSnapshot(owner: Resident, snapshot: AgentSnapshot): boolean {
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
    this.resolveOwner(workerId).safety = { ...safety }
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
    return [...this.residents.values()].map((owner) => ({
      workerId: owner.workerId,
      cwd: owner.cwd,
      sessionPath: owner.path,
      sessionId: owner.snapshot?.sessionId ?? null,
      generation: owner.snapshot?.generation ?? null,
      status: owner.snapshot?.status ?? 'opening',
      selected: this.selection?.workerId === owner.workerId
    }))
  }
}
