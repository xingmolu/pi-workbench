import {
  mutationCapabilitySchema,
  type MutationResponse
} from '../shared/runtime-capabilities'
import type { SelectedSessionScope } from '../shared/session-runtime'
import { ProjectMutationLeases } from './project-mutation-leases'

export type SessionCapabilityIdentity = {
  sessionId: string | null
  generation: number
}

export type ForegroundCapabilityToken = SessionCapabilityIdentity & {
  workerId: string
  selectionEpoch: number
}

type MutationOwner = {
  controller: AbortController
  release(): void
  granted: boolean
}

/**
 * Main-owned authority boundary for privileged session capabilities.
 *
 * Project mutation is the first capability moved behind this broker. Browser,
 * desktop control and future plugin capabilities can share the same captured
 * foreground authority instead of each reimplementing worker/session checks.
 */
export class CapabilityBroker {
  private readonly mutationOwners = new Map<string, Map<string, MutationOwner>>()

  constructor(private readonly mutationLeases = new ProjectMutationLeases()) {}

  /**
   * Capture foreground authority before asynchronous privileged work begins.
   * The token is valid only while both desktop selection and native session
   * identity stay unchanged.
   */
  captureForeground(
    workerId: string,
    requestIdentity: SessionCapabilityIdentity,
    selected: SelectedSessionScope | null,
    residentIdentity: SessionCapabilityIdentity | null
  ): ForegroundCapabilityToken | null {
    if (
      selected?.workerId !== workerId ||
      !residentIdentity ||
      residentIdentity.sessionId !== requestIdentity.sessionId ||
      residentIdentity.generation !== requestIdentity.generation
    )
      return null
    return {
      workerId,
      selectionEpoch: selected.selectionEpoch,
      sessionId: requestIdentity.sessionId,
      generation: requestIdentity.generation
    }
  }

  retainsForeground(
    token: ForegroundCapabilityToken,
    selected: SelectedSessionScope | null,
    residentIdentity: SessionCapabilityIdentity | null
  ): boolean {
    return Boolean(
      selected &&
        selected.workerId === token.workerId &&
        selected.selectionEpoch === token.selectionEpoch &&
        residentIdentity &&
        residentIdentity.sessionId === token.sessionId &&
        residentIdentity.generation === token.generation
    )
  }

  /** Handle worker-originated capability wire messages. */
  handleWorkerMessage(
    workerId: string,
    cwd: string,
    identity: SessionCapabilityIdentity | null,
    message: unknown,
    reply: (message: MutationResponse) => void
  ): boolean {
    const parsed = mutationCapabilitySchema.safeParse(message)
    if (!parsed.success) return false
    const request = parsed.data
    const owner = this.mutationOwners.get(workerId) ?? new Map<string, MutationOwner>()
    this.mutationOwners.set(workerId, owner)

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
    const entry: MutationOwner = {
      controller: new AbortController(),
      release,
      granted: false
    }
    owner.set(request.requestId, entry)

    void this.mutationLeases
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
        if (!owner.size) this.mutationOwners.delete(workerId)
      })
    return true
  }

  /** Compatibility entry while Main migrates to handleWorkerMessage. */
  handle(
    workerId: string,
    cwd: string,
    identity: SessionCapabilityIdentity | null,
    message: unknown,
    reply: (message: MutationResponse) => void
  ): boolean {
    return this.handleWorkerMessage(workerId, cwd, identity, message, reply)
  }

  workerExited(workerId: string): void {
    for (const pending of this.mutationOwners.get(workerId)?.values() ?? []) {
      pending.controller.abort()
      pending.release()
    }
    this.mutationLeases.cancelOwner(workerId)
    this.mutationOwners.delete(workerId)
  }

  /** Compatibility entry while existing lifecycle hooks still call exit(). */
  exit(workerId: string): void {
    this.workerExited(workerId)
  }

  get pending(): boolean {
    return this.mutationOwners.size > 0
  }

  hasPending(workerId: string): boolean {
    return (this.mutationOwners.get(workerId)?.size ?? 0) > 0
  }
}
