import { randomUUID } from 'node:crypto'
import type { MutationCapability, MutationResponse } from '../shared/runtime-capabilities'

export class ProjectMutationClient {
  private readonly calls = new Map<
    string,
    { requestId: string; granted: boolean; cancelled: boolean; resolve(value: boolean): void }
  >()
  constructor(private readonly send: (message: MutationCapability) => void) {}
  async acquire(
    callId: string,
    identity: { sessionId: string; generation: number },
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error('项目操作已取消')
    const requestId = randomUUID()
    let resolve!: (value: boolean) => void
    const response = new Promise<boolean>((done) => {
      resolve = done
    })
    const entry = { requestId, granted: false, cancelled: false, resolve }
    this.calls.set(callId, entry)
    const abort = () => {
      if (!entry.granted) {
        entry.cancelled = true
        this.send({ type: 'project-mutation', action: 'cancel', requestId })
      }
    }
    signal?.addEventListener('abort', abort, { once: true })
    this.send({ type: 'project-mutation', action: 'acquire', requestId, ...identity })
    try {
      if (!(await response)) {
        this.calls.delete(callId)
        throw new Error('项目操作已取消')
      }
      entry.granted = true
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }
  accept(response: MutationResponse): void {
    for (const entry of this.calls.values())
      if (entry.requestId === response.requestId) {
        if (entry.cancelled) {
          if (response.ok)
            this.send({ type: 'project-mutation', action: 'release', requestId: entry.requestId })
          entry.resolve(false)
          return
        }
        entry.granted = response.ok
        entry.resolve(response.ok)
      }
  }
  release(callId: string): void {
    const entry = this.calls.get(callId)
    if (!entry) return
    this.send({
      type: 'project-mutation',
      action: entry.granted ? 'release' : 'cancel',
      requestId: entry.requestId
    })
    this.calls.delete(callId)
  }
  cancelQueued(): void {
    for (const entry of this.calls.values())
      if (!entry.granted) {
        entry.cancelled = true
        this.send({ type: 'project-mutation', action: 'cancel', requestId: entry.requestId })
      }
  }
}
