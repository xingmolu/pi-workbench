import { realpath } from 'node:fs/promises'

/** Main-side writes hold the lease until their operation actually settles. */
export class ProjectMutationLeases {
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly owners = new Map<string, Set<AbortController>>()
  constructor(private readonly canonicalize: (cwd: string) => Promise<string> = realpath) {}

  run<T>(
    workerId: string,
    cwd: string,
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const controller = new AbortController()
    const owner = this.owners.get(workerId) ?? new Set<AbortController>()
    owner.add(controller)
    this.owners.set(workerId, owner)
    let started = false
    const cancellation = new Error('Project mutation cancelled')
    const abort = () => controller.abort()
    let rejectCancellation!: (error: Error) => void
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancellation = reject
    })
    const onAbort = () => {
      if (!started) rejectCancellation(cancellation)
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const result = (async () => {
      const key = await this.canonicalize(cwd)
      if (controller.signal.aborted) throw cancellation
      const execution = (this.tails.get(key) ?? Promise.resolve()).then(() => {
        if (controller.signal.aborted) throw cancellation
        started = true
        return operation(controller.signal)
      })
      const tail = execution.catch(() => {})
      this.tails.set(key, tail)
      try {
        return await execution
      } finally {
        if (this.tails.get(key) === tail) this.tails.delete(key)
      }
    })()
    return Promise.race([result, cancelled]).finally(() => {
      signal?.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', onAbort)
      owner.delete(controller)
      if (owner.size === 0) this.owners.delete(workerId)
    })
  }

  /** Cancels admission and signals active writes; they retain ownership until settled. */
  cancelOwner(workerId: string): void {
    for (const controller of this.owners.get(workerId) ?? []) controller.abort()
  }
}
