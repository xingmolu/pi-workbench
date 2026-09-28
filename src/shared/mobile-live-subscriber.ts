import type { MobileConversationSnapshot } from './mobile-gateway'

type Source = {
  close(): void
  addEventListener(type: string, listener: (event: { data: string }) => void): void
  /** EventSource.readyState: 0 connecting, 1 open, 2 closed for good. */
  readonly readyState?: number
}

export type MobileConnection = 'live' | 'retrying' | 'closed'

/** Serialized into the mobile client: all callbacks belong to one view/source epoch. */
export function createMobileLiveSubscriber(options: {
  source(workerId: string): Source
  fetch(workerId: string): Promise<MobileConversationSnapshot>
  snapshot(snapshot: MobileConversationSnapshot): void
  finished(): void
  paused(paused: boolean): void
  error(error: unknown): void
  /** Browser-level stream state; `closed` means it will not retry on its own. */
  connection?(state: MobileConnection): void
}) {
  let epoch = 0
  let navigation = 0
  let worker: string | null = null
  let source: Source | null = null
  let paused = false
  let accepted: MobileConversationSnapshot | null = null
  let refresh: Promise<void> | null = null
  function stop(): number {
    epoch++
    source?.close()
    source = null
    worker = null
    accepted = null
    refresh = null
    paused = false
    options.paused(false)
    return epoch
  }
  async function navigate(
    load: () => Promise<MobileConversationSnapshot>,
    select: (snapshot: MobileConversationSnapshot) => void
  ): Promise<void> {
    const capturedNavigation = ++navigation
    const capturedEpoch = epoch
    const current = (): boolean => navigation === capturedNavigation && epoch === capturedEpoch
    // Keep the displayed worker live (or intentionally paused) until navigation succeeds.
    try {
      const snapshot = await load()
      if (current()) {
        const next = worker === snapshot.workerId && isOlder(snapshot) ? accepted! : snapshot
        select(next)
        // Selection may replace the source and reset its watermark. Seed the displayed
        // HTTP revision so an older queued SSE frame cannot roll it back.
        if (worker === next.workerId && !isOlder(next)) accepted = next
      }
    } catch (error) {
      if (current()) options.error(error)
    }
  }
  function isOlder(snapshot: MobileConversationSnapshot): boolean {
    return (
      accepted !== null &&
      (snapshot.generation < accepted.generation ||
        (snapshot.generation === accepted.generation && snapshot.revision < accepted.revision))
    )
  }
  function accept(snapshot: MobileConversationSnapshot): void {
    if (isOlder(snapshot)) return
    accepted = snapshot
    options.snapshot(snapshot)
  }
  function fetchSnapshot(): Promise<void> {
    if (!worker) return Promise.resolve()
    if (refresh) return refresh
    const capturedEpoch = epoch
    const capturedWorker = worker
    const request = options
      .fetch(capturedWorker)
      .then((snapshot) => {
        if (epoch === capturedEpoch && snapshot.workerId === capturedWorker) accept(snapshot)
      })
      .catch((error: unknown) => {
        if (epoch === capturedEpoch) options.error(error)
      })
      .finally(() => {
        if (refresh === request) refresh = null
      })
    refresh = request
    return request
  }
  function watch(workerId: string): void {
    if (worker === workerId) return
    stop()
    worker = workerId
    const capturedEpoch = epoch
    const current = options.source(workerId)
    source = current
    const valid = (): boolean => epoch === capturedEpoch && source === current && !paused
    current.addEventListener('snapshot', (event) => {
      if (!valid()) return
      try {
        const snapshot = JSON.parse(event.data) as MobileConversationSnapshot
        if (snapshot.workerId === workerId) accept(snapshot)
      } catch (error) {
        options.error(error)
      }
    })
    current.addEventListener('open', () => {
      if (epoch === capturedEpoch && source === current) options.connection?.('live')
    })
    current.addEventListener('error', () => {
      if (epoch !== capturedEpoch || source !== current) return
      options.connection?.(current.readyState === 2 ? 'closed' : 'retrying')
    })
    current.addEventListener('run-finished', () => {
      if (valid()) options.finished()
    })
    current.addEventListener('resync-required', (event) => {
      if (!valid()) return
      try {
        if (JSON.parse(event.data).workerId !== workerId) return
      } catch {
        return
      }
      paused = true
      current.close()
      source = null
      options.paused(true)
      // A request begun before this notice may have captured older state. Follow it
      // once, without overlapping requests or reopening the paused event source.
      if (refresh) {
        void refresh.then(() => {
          if (epoch === capturedEpoch && paused) void fetchSnapshot()
        })
      } else void fetchSnapshot()
    })
  }
  /** Replace a dropped stream for the same session and catch up over HTTP. */
  function reconnect(): Promise<void> {
    const current = worker
    if (!current || paused) return fetchSnapshot()
    stop()
    watch(current)
    return fetchSnapshot()
  }
  return {
    watch,
    stop,
    reconnect,
    refresh: fetchSnapshot,
    navigate
  }
}
