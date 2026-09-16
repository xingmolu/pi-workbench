import type { AgentSession, PromptOptions } from '@earendil-works/pi-coding-agent'

export type AttachmentAcceptance = 'accepted' | 'rejected' | 'uncertain'

/** Compatibility debt: exported PromptOptions declares this internal RPC hook.
 * Pinned to SDK 0.84.4 and tested against its offline provider. Acceptance does
 * not promise transcript persistence, model delivery, or a successful answer.
 */
export function observeAttachmentPrompt(
  session: Pick<AgentSession, 'prompt'>,
  text: string,
  timeoutMs = 15000,
  onResult?: (result: Exclude<AttachmentAcceptance, 'uncertain'>) => void,
  onError?: (error: unknown) => void,
  images?: PromptOptions['images']
): { receipt: Promise<AttachmentAcceptance>; finished: Promise<void> } {
  let resolve!: (result: AttachmentAcceptance) => void
  let settled = false
  const receipt = new Promise<AttachmentAcceptance>((done) => {
    resolve = done
  })
  const timer = setTimeout(() => resolve('uncertain'), timeoutMs)
  const preflightResult: NonNullable<PromptOptions['preflightResult']> = (success) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    const result = success ? 'accepted' : 'rejected'
    resolve(result)
    try {
      onResult?.(result)
    } catch {
      /* Observers cannot change SDK acceptance. */
    }
  }
  const finished = Promise.resolve()
    .then(() =>
      session.prompt(text, {
        source: 'rpc',
        expandPromptTemplates: false,
        ...(images?.length ? { images } : {}),
        preflightResult
      })
    )
    .catch((error) => {
      try {
        onError?.(error)
      } catch {
        /* Observer is not part of prompt completion. */
      }
      // A throw without the callback is unknown; do not infer safe retry.
      if (!settled) resolve('uncertain')
    })
    .finally(() => {
      clearTimeout(timer)
      if (!settled) resolve('uncertain')
    })
  return { receipt, finished }
}
