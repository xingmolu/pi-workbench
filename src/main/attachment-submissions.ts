import type { AttachmentReceipt, AttachmentScope, TextSnapshot } from '../shared/text-attachments'

export type AttachmentSubmission = {
  owner: number
  workerId?: string
  scope: AttachmentScope
  files: TextSnapshot[]
  ids: string[]
  receipt: AttachmentReceipt
  at: number
  pending?: Promise<AttachmentReceipt>
}

/** Payloads belong to the authoritative scope or an outstanding Host request. */
export class AttachmentSubmissions extends Map<string, AttachmentSubmission> {
  private scope: string | null = null
  constructor(private readonly options: { retainUncertain?: boolean } = {}) {
    super()
  }

  setContext(scope: AttachmentScope | null): void {
    this.scope = scope ? JSON.stringify(scope) : null
    this.prune()
  }

  prune(): void {
    for (const [id, entry] of this) {
      if (entry.pending) continue
      const obsolete = JSON.stringify(entry.scope) !== this.scope
      if (obsolete || entry.receipt.status !== 'uncertain') entry.files = []
      if (
        (obsolete && entry.receipt.status === 'uncertain' && !this.options.retainUncertain) ||
        (entry.receipt.status !== 'uncertain' && Date.now() - entry.at > 30 * 60 * 1000)
      )
        this.delete(id)
    }
  }

  retireScope(scope: AttachmentScope): void {
    const key = JSON.stringify(scope)
    for (const [id, entry] of this)
      if (JSON.stringify(entry.scope) === key) {
        entry.files = []
        this.delete(id)
      }
  }

  retireWorker(workerId: string): void {
    for (const [id, entry] of this)
      if (entry.workerId === workerId) {
        entry.files = []
        this.delete(id)
      }
  }

  reserve(submissionId: string): AttachmentReceipt | null {
    this.prune()
    while (this.size >= 32) {
      const oldest = [...this].find(
        ([, entry]) => !entry.pending && entry.receipt.status !== 'uncertain'
      )
      if (!oldest) return { submissionId, status: 'rejected', code: 'busy' }
      this.delete(oldest[0])
    }
    return null
  }
}
