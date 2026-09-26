type SnapshotTransport = {
  readonly writableEnded: boolean
  readonly destroyed: boolean
  write(chunk: string): boolean
  end(): unknown
  destroy(): unknown
  on(event: 'drain' | 'close' | 'error', listener: () => void): unknown
  off(event: 'drain' | 'close' | 'error', listener: () => void): unknown
}

export type MobileSnapshotStreamOptions = {
  maxFrameBytes?: number
  backpressureTimeoutMs?: number
}

/** Retain only the latest unsent snapshot. Never serialize while backpressured. */
export class MobileSnapshotStream {
  private pending: (() => string) | null = null
  private finished = false
  private blocked = false
  private disposed = false
  private ending = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private deadline: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly response: SnapshotTransport,
    private readonly workerId: string,
    private readonly options: MobileSnapshotStreamOptions = {}
  ) {
    response.on('drain', this.drain)
    response.on('close', this.dispose)
    response.on('error', this.fail)
  }

  getDiagnostics(): { blocked: boolean; pending: boolean } {
    return { blocked: this.blocked, pending: this.pending !== null }
  }

  publish(snapshot: () => string, immediate = false, runFinished = false): void {
    if (this.disposed || this.ending) return
    this.pending = snapshot
    this.finished ||= runFinished
    if (this.blocked) return
    if (immediate) this.flush()
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 200)
  }

  dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.clearTimer()
    this.clearDeadline()
    this.pending = null
    this.finished = false
    this.blocked = false
    this.response.off('drain', this.drain)
    this.response.off('close', this.dispose)
    this.response.off('error', this.fail)
  }

  private fail = (): void => {
    this.dispose()
    this.response.destroy()
  }

  private drain = (): void => {
    if (this.ending) return
    this.clearDeadline()
    this.blocked = false
    this.flush()
  }

  private clearDeadline(): void {
    if (this.deadline) clearTimeout(this.deadline)
    this.deadline = null
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private flush(): void {
    this.clearTimer()
    if (this.disposed || this.blocked || !this.pending) return
    if (this.response.writableEnded || this.response.destroyed) {
      this.dispose()
      return
    }
    try {
      let frame = `event: snapshot\ndata: ${this.pending()}\n\n`
      if (this.finished)
        frame += `event: run-finished\ndata: ${JSON.stringify({ workerId: this.workerId })}\n\n`
      if (Buffer.byteLength(frame, 'utf8') > (this.options.maxFrameBytes ?? 8 * 1024 * 1024)) {
        this.ending = true
        this.pending = null
        this.finished = false
        this.blocked = !this.response.write(
          `event: resync-required\ndata: ${JSON.stringify({ workerId: this.workerId })}\n\n`
        )
        this.response.end()
        // Even a tiny terminal notice can wait behind an unread socket buffer.
        if (!this.disposed)
          this.deadline = setTimeout(this.fail, this.options.backpressureTimeoutMs ?? 15_000)
        return
      }
      this.pending = null
      this.finished = false
      // A false return accepts this frame; retrying it would duplicate events.
      this.blocked = !this.response.write(frame)
      if (this.blocked)
        this.deadline = setTimeout(this.fail, this.options.backpressureTimeoutMs ?? 15_000)
    } catch {
      this.fail()
    }
  }
}
