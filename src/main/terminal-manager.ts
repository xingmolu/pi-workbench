import { randomUUID } from 'node:crypto'
import {
  TERMINAL_LIMITS as LIMIT,
  terminalCommandSchema,
  terminalEventSchema,
  type TerminalEvent,
  type TerminalHostCommand,
  type TerminalMetadata,
  type TerminalResult
} from '../shared/terminal'

export type TerminalTransport = { postMessage(command: TerminalHostCommand): void; kill(): void }
type Options = {
  canonicalProject(path: string): Promise<string | null>
  startHost(handlers: {
    message(value: unknown): void
    exit(): void
    diagnostic(): void
  }): Promise<TerminalTransport>
}
type Entry = {
  metadata: TerminalMetadata
  owner: number
  hostEpoch: number
  spawned: boolean
  sequence: number
  ledger: Map<number, number>
  bytes: number
  windowStart: number
  inputBytes: number
  calls: number
}
const unavailable = (): TerminalResult => ({
  type: 'unavailable',
  message: '终端请求无效、连接已失效或资源上限已达到'
})

export class TerminalManager {
  private currentProject: string | null = null
  private windows = new Map<number, (event: TerminalEvent) => void>()
  private entries = new Map<string, Entry>()
  private host?: Promise<TerminalTransport>
  private port?: TerminalTransport
  private hostEpoch = 0
  private lifecycleGeneration = 0
  private failedHostEpoch = -1
  private stopped = false
  private shutdownPromise?: Promise<void>
  private hostExited?: () => void
  private closedOwners = new Set<number>()
  constructor(private options: Options) {}
  registerWindow(id: number, send: (event: TerminalEvent) => void): void {
    if (this.shutdownPromise || this.closedOwners.has(id)) return
    this.windows.set(id, send)
    this.stopped = false
  }
  setProject(project: string | null): void {
    this.currentProject = project
  }
  invalidateWindow(owner: number): void {
    this.windows.delete(owner)
    for (const entry of this.entries.values()) {
      if (entry.owner !== owner) continue
      const t = entry.metadata
      t.connectionEpoch++
      t.connection = 'management'
      if (!t.exitConfirmed && !t.failure && t.state !== 'closing') t.state = 'degraded'
      if (entry.spawned) this.send(entry, { type: 'detach', ...this.identity(t) })
    }
  }
  async dispatch(owner: number, value: unknown): Promise<TerminalResult> {
    const parsed = terminalCommandSchema.safeParse(value)
    if (!parsed.success || !this.windows.has(owner) || this.stopped) return unavailable()
    const command = parsed.data
    const management = ['list', 'create', 'attach', 'close'].includes(command.type)
    if (management && command.projectPath !== this.currentProject) return unavailable()
    if (command.type === 'list')
      return {
        type: 'list',
        terminals: [...this.entries.values()]
          .filter((e) => e.owner === owner && e.metadata.projectPath === command.projectPath)
          .map((e) => ({ ...e.metadata }))
      }
    if (command.type !== 'create') {
      const entry = this.entries.get(command.terminalId)
      if (!entry || entry.owner !== owner) return unavailable()
      const t = entry.metadata
      if (
        t.generation !== command.generation ||
        t.projectPath !== command.projectPath ||
        t.connectionEpoch !== command.connectionEpoch
      )
        return unavailable()
      if (command.type === 'close') {
        if (t.exitConfirmed) {
          this.send(entry, { type: 'dismiss', ...this.identity(t) })
          this.entries.delete(t.terminalId)
          return { type: 'ok' }
        }
        if (!t.failure) t.state = 'closing'
        this.send(entry, { type: 'command', command })
        return { type: 'terminal', terminal: { ...t } }
      }
      if (command.type === 'attach') {
        if (t.state === 'closing') return unavailable()
        if (!entry.spawned && !t.exitConfirmed) return unavailable()
        if (t.connection !== 'management' && !t.failure) t.connection = 'consumer'
        this.send(entry, { type: 'command', command })
        return { type: 'terminal', terminal: { ...t } }
      }
      if (t.connection !== 'consumer' || t.failure || t.state === 'closing') return unavailable()
      if (command.type === 'ack') {
        if (!entry.ledger.has(command.sequence)) return unavailable()
        for (const [sequence, bytes] of entry.ledger) {
          if (sequence > command.sequence) break
          entry.ledger.delete(sequence)
          entry.bytes -= bytes
        }
      } else {
        if (t.state !== 'running') return unavailable()
        const now = Date.now()
        if (now - entry.windowStart >= 1000) {
          entry.windowStart = now
          entry.inputBytes = 0
          entry.calls = 0
        }
        if (++entry.calls > LIMIT.commandsPerSecond) return unavailable()
        if (command.type === 'input') {
          const bytes =
            command.encoding === 'binary' ? command.data.length : Buffer.byteLength(command.data)
          if (entry.inputBytes + bytes > LIMIT.inputPerSecond) return unavailable()
          entry.inputBytes += bytes
        }
      }
      if (!this.send(entry, { type: 'command', command })) return unavailable()
      return { type: 'ok' }
    }
    const active = [...this.entries.values()].filter((entry) => !entry.metadata.exitConfirmed)
    if (
      active.length >= LIMIT.total ||
      active.filter((e) => e.metadata.projectPath === command.projectPath).length >=
        LIMIT.perProject
    )
      return unavailable()
    const metadata: TerminalMetadata = {
      projectPath: command.projectPath,
      terminalId: randomUUID(),
      generation: randomUUID(),
      connectionEpoch: 1,
      cols: command.cols,
      rows: command.rows,
      state: 'starting',
      connection: 'unattached',
      exitConfirmed: false,
      exitCode: null,
      signal: null,
      failure: null
    }
    const entry: Entry = {
      metadata,
      owner,
      hostEpoch: 0,
      spawned: false,
      sequence: 0,
      ledger: new Map(),
      bytes: 0,
      windowStart: 0,
      inputBytes: 0,
      calls: 0
    }
    this.entries.set(metadata.terminalId, entry)
    const startupGeneration = this.lifecycleGeneration
    const mayStart = (): boolean =>
      !this.stopped &&
      startupGeneration === this.lifecycleGeneration &&
      !this.closedOwners.has(owner) &&
      (this.windows.has(owner) || metadata.connection === 'management')
    try {
      if ((await this.options.canonicalProject(command.projectPath)) !== command.projectPath)
        throw new Error('Invalid project')
      if (!mayStart()) throw new Error('Stopped')
      if (!this.host) {
        const epoch = ++this.hostEpoch
        this.host = this.options.startHost({
          message: (v) => this.message(epoch, v),
          exit: () => this.crashed(epoch),
          diagnostic: () => this.serviceFailure(epoch)
        })
      }
      entry.hostEpoch = this.hostEpoch
      const host = await this.host
      if (
        !mayStart() ||
        entry.hostEpoch !== this.hostEpoch ||
        this.failedHostEpoch === this.hostEpoch ||
        metadata.failure
      )
        throw new Error('Stopped')
      this.port = host
      entry.spawned = true
      host.postMessage({
        type: 'spawn',
        ...this.identity(metadata),
        cols: metadata.cols,
        rows: metadata.rows,
        degraded: metadata.connection === 'management'
      })
      if (metadata.state === 'closing')
        host.postMessage({
          type: 'command',
          command: { type: 'close', ...this.identity(metadata) }
        })
      return { type: 'terminal', terminal: { ...metadata } }
    } catch {
      metadata.state = 'failed'
      metadata.failure ??= 'spawn'
      metadata.exitConfirmed = !entry.spawned
      if (!entry.spawned && entry.hostEpoch === this.hostEpoch) {
        this.host = undefined
        this.port = undefined
      }
      this.prune()
      return { type: 'terminal', terminal: { ...metadata } }
    }
  }
  private identity(t: TerminalMetadata) {
    return {
      projectPath: t.projectPath,
      terminalId: t.terminalId,
      generation: t.generation,
      connectionEpoch: t.connectionEpoch
    }
  }
  private send(entry: Entry, command: TerminalHostCommand): boolean {
    if (!entry.spawned || entry.hostEpoch !== this.hostEpoch || !this.port) return false
    try {
      this.port.postMessage(command)
      return true
    } catch {
      this.crashed(this.hostEpoch)
      return false
    }
  }
  private message(epoch: number, value: unknown): void {
    if (epoch !== this.hostEpoch) return
    const parsed = terminalEventSchema.safeParse(value)
    if (!parsed.success) return
    const event = parsed.data
    const incoming = event.type === 'state' ? event.terminal : event
    const entry = this.entries.get(incoming.terminalId)
    if (!entry || entry.hostEpoch !== epoch || !entry.spawned) return
    const t = entry.metadata
    if (
      incoming.projectPath !== t.projectPath ||
      incoming.generation !== t.generation ||
      incoming.connectionEpoch !== t.connectionEpoch
    )
      return
    if (event.type === 'state') {
      // Ownership, project and consumer authority are Main-issued, never adopted from output.
      if (t.exitConfirmed || (t.failure && !event.terminal.exitConfirmed)) return
      if (
        t.state === 'closing' &&
        ['starting', 'running', 'degraded'].includes(event.terminal.state)
      )
        return
      t.exitConfirmed = event.terminal.exitConfirmed
      if (event.terminal.busy === undefined) delete t.busy
      else t.busy = event.terminal.busy
      t.exitCode = event.terminal.exitCode
      t.signal = event.terminal.signal
      t.cols = event.terminal.cols
      t.rows = event.terminal.rows
      t.failure ??= event.terminal.failure
      t.state = t.failure
        ? 'failed'
        : t.connection === 'management' && !t.exitConfirmed && t.state !== 'closing'
          ? 'degraded'
          : event.terminal.state
      this.windows.get(entry.owner)?.({ type: 'state', terminal: { ...t } })
      this.prune()
    } else {
      if (t.connection !== 'consumer' || t.failure || !this.windows.has(entry.owner)) return
      const bytes = Buffer.byteLength(event.data)
      if (
        event.sequence !== entry.sequence + 1 ||
        entry.bytes + bytes > LIMIT.hard ||
        entry.ledger.size >= 4096
      ) {
        t.state = 'failed'
        t.failure = 'protocol'
        this.send(entry, { type: 'command', command: { type: 'close', ...this.identity(t) } })
        this.windows.get(entry.owner)?.({ type: 'state', terminal: { ...t } })
        return
      }
      entry.sequence = event.sequence
      entry.ledger.set(event.sequence, bytes)
      entry.bytes += bytes
      this.windows.get(entry.owner)?.(event)
    }
  }
  private crashed(epoch: number): void {
    if (epoch !== this.hostEpoch) return
    this.port = undefined
    this.host = undefined
    for (const entry of this.entries.values()) {
      if (entry.hostEpoch !== epoch || entry.metadata.exitConfirmed) continue
      entry.metadata.state = 'failed'
      entry.metadata.failure ??= 'host-exit'
      // Lost host is not proof of shell/descendant exit. Its slot remains reserved.
      this.windows.get(entry.owner)?.({ type: 'state', terminal: { ...entry.metadata } })
    }
    this.hostExited?.()
  }
  private serviceFailure(epoch: number): void {
    if (epoch !== this.hostEpoch || this.failedHostEpoch === epoch) return
    this.failedHostEpoch = epoch
    for (const entry of this.entries.values()) {
      if (entry.hostEpoch !== epoch || entry.metadata.exitConfirmed) continue
      entry.metadata.state = 'failed'
      entry.metadata.failure = 'host-io'
      this.windows.get(entry.owner)?.({ type: 'state', terminal: { ...entry.metadata } })
    }
    const pending = this.host
    if (!pending) return
    // node-pty's asynchronous write errors reach infrastructure stderr, not its public events.
    // Fail the whole utility conservatively, without inspecting or forwarding diagnostic text.
    void pending
      .then(async (port) => {
        try {
          port.postMessage({ type: 'shutdown' })
        } catch {
          /* Still apply bounded cleanup. */
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 2500))
        port.kill()
        this.crashed(epoch)
      })
      .catch(() => this.crashed(epoch))
  }
  private prune(): void {
    const history = [...this.entries.values()].filter((e) => e.metadata.exitConfirmed)
    while (history.length > LIMIT.history) {
      const entry = history.shift()!
      this.send(entry, { type: 'dismiss', ...this.identity(entry.metadata) })
      this.entries.delete(entry.metadata.terminalId)
    }
  }
  /** Closes every live terminal, e.g. when the terminal plugin is turned off. */
  closeAll(): void {
    for (const entry of this.entries.values()) {
      const t = entry.metadata
      if (t.exitConfirmed || t.state === 'closing') continue
      if (!t.failure) t.state = 'closing'
      this.send(entry, { type: 'command', command: { type: 'close', ...this.identity(t) } })
    }
  }
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.lifecycleGeneration++
    this.stopped = true
    for (const entry of this.entries.values()) this.closedOwners.add(entry.owner)
    for (const owner of [...this.windows.keys()]) {
      this.closedOwners.add(owner)
      this.invalidateWindow(owner)
    }
    this.shutdownPromise = (async () => {
      const pending = this.host
      if (!pending) return
      let timer: ReturnType<typeof setTimeout> | undefined
      let shutdownPort: TerminalTransport | undefined
      let expired = false
      const exited = new Promise<void>((resolve) => {
        this.hostExited = resolve
        timer = setTimeout(resolve, 2500)
      })
      void pending
        .then((port) => {
          shutdownPort = port
          if (expired) {
            port.kill()
            return
          }
          port.postMessage({ type: 'shutdown' })
        })
        .catch(() => this.hostExited?.())
      await exited
      clearTimeout(timer)
      expired = true
      shutdownPort?.kill()
      this.crashed(this.hostEpoch)
    })().finally(() => {
      this.shutdownPromise = undefined
    })
    return this.shutdownPromise
  }
}
