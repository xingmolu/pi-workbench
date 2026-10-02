import {
  TERMINAL_LIMITS as LIMIT,
  terminalCommandSchema,
  type TerminalCommand,
  type TerminalEvent,
  type TerminalIdentity,
  type TerminalMetadata
} from '../shared/terminal'
import { shellName } from '../shared/terminal-shell'

export type PtyPort = {
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
  pause(): void
  resume(): void
  write(data: string | Buffer): void
  resize(cols: number, rows: number): void
  kill(signal: string): void
  /** Bytes written but not yet taken by the shell, when the PTY can tell. */
  pendingWriteBytes?(): number
  /** Name of the foreground process, when the PTY can tell. */
  readonly process?: string
}
type Options = {
  spawn(): PtyPort
  emit(event: TerminalEvent): void
  closeTimeoutMs?: number
  /** The shell's own name; any other foreground process means a program is running. */
  shellName?: string
  /** How often to look at the foreground process. */
  foregroundPollMs?: number
}

export class TerminalSession {
  private pty?: PtyPort
  private queued = ''
  private sequence = 0
  private outstanding = new Map<number, number>()
  private outstandingBytes = 0
  private scheduled = false
  private paused = true
  private closing?: Promise<void>
  private finishClose?: () => void
  private closingTimer?: ReturnType<typeof setTimeout>
  private disposables: { dispose(): void }[] = []
  private foregroundTimer?: ReturnType<typeof setInterval>
  readonly metadata: TerminalMetadata
  constructor(
    identity: TerminalIdentity & { cols: number; rows: number },
    private options: Options
  ) {
    this.metadata = {
      projectPath: identity.projectPath,
      terminalId: identity.terminalId,
      generation: identity.generation,
      connectionEpoch: identity.connectionEpoch,
      cols: identity.cols,
      rows: identity.rows,
      state: 'starting',
      connection: 'unattached',
      exitConfirmed: false,
      exitCode: null,
      signal: null,
      failure: null
    }
  }
  start(): void {
    try {
      this.pty = this.options.spawn()
    } catch {
      this.metadata.state = 'failed'
      this.metadata.failure = 'spawn'
      this.metadata.exitConfirmed = true
      this.state()
      return
    }
    this.disposables.push(
      this.pty.onData((data) => {
        if (this.closing || this.metadata.failure) return
        // Include both delivered-but-unacked and queued bytes. Never retain an over-limit chunk.
        if (
          this.outstandingBytes + Buffer.byteLength(this.queued) + Buffer.byteLength(data) >
          LIMIT.hard
        ) {
          this.fail('output-limit')
          return
        }
        this.queued += data
        this.scheduleFlush()
        this.flow()
      })
    )
    this.disposables.push(
      this.pty.onExit(({ exitCode, signal }) => {
        this.metadata.exitConfirmed = true
        this.metadata.exitCode = exitCode
        this.metadata.signal = signal ?? null
        this.metadata.state = this.metadata.failure ? 'failed' : 'exited'
        clearTimeout(this.closingTimer)
        clearInterval(this.foregroundTimer)
        this.metadata.busy = false
        this.finishClose?.()
        this.disposables.forEach((d) => d.dispose())
        this.disposables = []
        this.flush()
        this.state()
      })
    )
    this.pty.pause()
    if (!this.metadata.exitConfirmed && !this.metadata.failure)
      this.metadata.state = this.metadata.connection === 'management' ? 'degraded' : 'running'
    this.watchForeground()
    this.state()
  }
  /** Tracks whether a program other than the shell holds the terminal, e.g. `npm run dev`. */
  private watchForeground(): void {
    const shell = this.options.shellName
    let supported = false
    try {
      supported = typeof this.pty?.process === 'string'
    } catch {
      /* A PTY that cannot name its foreground process leaves busy unknown. */
    }
    if (!shell || !supported || this.metadata.exitConfirmed) return
    this.metadata.busy = false
    const check = (): void => {
      let name: string
      try {
        name = shellName(this.pty?.process ?? '')
      } catch {
        return
      }
      const busy = name !== '' && name !== shell
      if (busy === this.metadata.busy) return
      this.metadata.busy = busy
      this.state()
    }
    this.foregroundTimer = setInterval(check, this.options.foregroundPollMs ?? 1000)
    this.foregroundTimer.unref?.()
  }
  command(value: unknown): boolean {
    const parsed = terminalCommandSchema.safeParse(value)
    if (!parsed.success || !('terminalId' in parsed.data)) return false
    const command = parsed.data
    if (
      command.terminalId !== this.metadata.terminalId ||
      command.generation !== this.metadata.generation ||
      command.projectPath !== this.metadata.projectPath ||
      command.connectionEpoch !== this.metadata.connectionEpoch
    )
      return false
    try {
      return this.execute(command)
    } catch {
      this.rejectCommand()
      return false
    }
  }
  private execute(command: Exclude<TerminalCommand, { type: 'create' | 'list' }>): boolean {
    if (command.type === 'close') {
      void this.close()
      return true
    }
    if (command.type === 'ack') {
      if (this.metadata.connection !== 'consumer' || !this.outstanding.has(command.sequence))
        return false
      for (const [sequence, bytes] of this.outstanding) {
        if (sequence > command.sequence) break
        this.outstanding.delete(sequence)
        this.outstandingBytes -= bytes
      }
      this.flush()
      this.flow()
      return true
    }
    if (command.type === 'attach') {
      if (this.metadata.connection === 'management' || this.metadata.state === 'degraded') {
        this.metadata.connection = 'management'
        this.state()
        return true
      }
      if (this.metadata.failure || this.closing) return false
      this.metadata.connection = 'consumer'
      this.state()
      this.flush()
      this.flow()
      return true
    }
    if (this.metadata.connection !== 'consumer' || this.metadata.state !== 'running') return false
    // Main owns ingress rate windows. Applying a second clock here would reject valid bursts
    // delayed by IPC across window boundaries. Lifetime native-queue budgets are independent.
    if (command.type === 'input') {
      const bytes =
        command.encoding === 'binary' ? command.data.length : Buffer.byteLength(command.data)
      // Bound only what the shell has not read: a long-lived session may type forever,
      // but a shell that stops reading must not grow the native queue without limit.
      if ((this.pty?.pendingWriteBytes?.() ?? 0) + bytes > LIMIT.inputQueue) {
        this.fail('input-limit')
        return false
      }
      this.pty?.write(
        command.encoding === 'binary' ? Buffer.from(command.data, 'binary') : command.data
      )
      return true
    }
    if (command.type === 'resize') {
      this.pty?.resize(command.cols, command.rows)
      this.metadata.cols = command.cols
      this.metadata.rows = command.rows
      this.state()
      return true
    }
    return false
  }
  rejectCommand(): void {
    if (!this.metadata.exitConfirmed && !this.metadata.failure) this.fail('protocol')
  }
  detach(epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch <= this.metadata.connectionEpoch) return
    this.metadata.connectionEpoch = epoch
    this.metadata.connection = 'management'
    if (!this.metadata.exitConfirmed && !this.metadata.failure && !this.closing)
      this.metadata.state = 'degraded'
    this.flow()
    this.state()
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    if (this.metadata.exitConfirmed) return Promise.resolve()
    if (!this.metadata.failure) this.metadata.state = 'closing'
    this.closing = new Promise((resolve) => {
      this.finishClose = resolve
    })
    clearInterval(this.foregroundTimer)
    this.pty?.pause()
    this.state()
    this.closingTimer = setTimeout(() => {
      if (!this.metadata.exitConfirmed) {
        this.metadata.state = 'failed'
        this.metadata.failure ??= 'close-timeout'
        this.state()
      }
      this.finishClose?.()
    }, this.options.closeTimeoutMs ?? 2000)
    // No PID-based escalation: node-pty has no durable identity handle after this signal.
    try {
      this.pty?.kill('SIGHUP')
    } catch {
      /* Await actual exit or report unconfirmed timeout. */
    }
    return this.closing
  }
  private fail(reason: NonNullable<TerminalMetadata['failure']>): void {
    this.metadata.failure = reason
    this.metadata.state = 'failed'
    this.state()
    void this.close()
  }
  private state(): void {
    this.options.emit({ type: 'state', terminal: { ...this.metadata } })
  }
  private scheduleFlush(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.flush()
    })
  }
  private flow(): void {
    const total = this.outstandingBytes + Buffer.byteLength(this.queued)
    if (
      this.metadata.connection !== 'consumer' ||
      this.closing ||
      this.metadata.failure ||
      this.metadata.exitConfirmed ||
      total >= LIMIT.high ||
      this.outstanding.size >= 4096
    ) {
      this.paused = true
      this.pty?.pause()
    } else if (total <= LIMIT.low && this.paused) {
      this.paused = false
      this.pty?.resume()
    }
  }
  private flush(): void {
    if (this.metadata.connection !== 'consumer' || this.metadata.failure || this.closing) return
    while (this.queued && this.outstandingBytes < LIMIT.high && this.outstanding.size < 4096) {
      let end = 0
      let bytes = 0
      for (const character of this.queued) {
        const code = character.charCodeAt(0)
        // A trailing high surrogate may be completed by the next native string.
        if (
          !this.metadata.exitConfirmed &&
          end + 1 === this.queued.length &&
          code >= 0xd800 &&
          code <= 0xdbff
        )
          break
        const size = Buffer.byteLength(character)
        if (bytes + size > LIMIT.chunk) break
        bytes += size
        end += character.length
      }
      if (!end) break
      const data = this.queued.slice(0, end)
      this.queued = this.queued.slice(end)
      this.outstanding.set(++this.sequence, bytes)
      this.outstandingBytes += bytes
      this.options.emit({
        type: 'output',
        projectPath: this.metadata.projectPath,
        terminalId: this.metadata.terminalId,
        generation: this.metadata.generation,
        connectionEpoch: this.metadata.connectionEpoch,
        sequence: this.sequence,
        data
      })
    }
    this.flow()
  }
}
