import { mutationCapabilitySchema, type MutationResponse } from '../shared/runtime-capabilities'
import { ProjectMutationLeases } from './project-mutation-leases'

/** An IPC lease ends only on the execution receipt or actual owner exit. */
export class WorkerMutationCapabilities {
  private readonly owners = new Map<
    string,
    Map<string, { controller: AbortController; release(): void; granted: boolean }>
  >()
  constructor(private readonly leases = new ProjectMutationLeases()) {}
  handle(
    workerId: string,
    cwd: string,
    identity: { sessionId: string | null; generation: number } | null,
    message: unknown,
    reply: (message: MutationResponse) => void
  ): boolean {
    const parsed = mutationCapabilitySchema.safeParse(message)
    if (!parsed.success) return false
    const request = parsed.data
    const owner = this.owners.get(workerId) ?? new Map()
    this.owners.set(workerId, owner)
    if (request.action !== 'acquire') {
      const pending = owner.get(request.requestId)
      if (request.action === 'release') pending?.release()
      else pending?.controller.abort()
      return true
    }
    if (
      owner.has(request.requestId) ||
      !identity ||
      identity.sessionId !== request.sessionId ||
      identity.generation !== request.generation
    ) {
      reply({ type: 'project-mutation-response', requestId: request.requestId, ok: false })
      return true
    }
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const entry = { controller: new AbortController(), release, granted: false }
    owner.set(request.requestId, entry)
    void this.leases
      .run(
        workerId,
        cwd,
        async () => {
          entry.granted = true
          reply({ type: 'project-mutation-response', requestId: request.requestId, ok: true })
          await released
        },
        entry.controller.signal
      )
      .catch(() => {
        if (!entry.granted)
          reply({ type: 'project-mutation-response', requestId: request.requestId, ok: false })
      })
      .finally(() => {
        owner.delete(request.requestId)
        if (!owner.size) this.owners.delete(workerId)
      })
    return true
  }
  exit(workerId: string): void {
    for (const pending of this.owners.get(workerId)?.values() ?? []) {
      pending.controller.abort()
      pending.release()
    }
    this.leases.cancelOwner(workerId)
    this.owners.delete(workerId)
  }
  get pending(): boolean {
    return this.owners.size > 0
  }
}
