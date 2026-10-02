import type { TerminalEvent, TerminalMetadata } from '../shared/terminal'
import {
  REMOTE_TERMINAL_KEYS,
  type RemoteTerminalInput,
  type RemoteViewSummary
} from '../shared/remote-views'
import { t } from '../shared/i18n'

export type RemoteTerminalSource = {
  observe(listener: (event: TerminalEvent) => void): () => void
  liveTerminals(): TerminalMetadata[]
  remoteInput(terminalId: string, data: string): boolean
}
export type RemoteTerminalEvent =
  | { type: 'replay'; data: string; cols: number; rows: number; state: TerminalMetadata['state'] }
  | { type: 'output'; data: string }
  | { type: 'state'; cols: number; rows: number; state: TerminalMetadata['state'] }
type Listener = (event: RemoteTerminalEvent) => void

/** Enough recent output to repaint a screen and some scrollback on a phone that joins late. */
const REPLAY_BYTES = 256 * 1024

const projectName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/**
 * Terminals for paired phones: a bounded replay of each terminal's recent output plus its
 * live output, and keystrokes forwarded under the desktop's own limits.
 */
export class RemoteTerminals {
  private readonly buffers = new Map<string, string>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private stop: (() => void) | undefined

  constructor(private readonly source: () => RemoteTerminalSource | null) {}

  /** Starts recording as soon as the desktop has terminals, so a late viewer has history. */
  attach(): void {
    const source = this.source()
    if (!source || this.stop) return
    this.stop = source.observe((event) => this.record(event))
  }

  detach(): void {
    this.stop?.()
    this.stop = undefined
    this.buffers.clear()
  }

  list(): RemoteViewSummary[] {
    const terminals = this.source()?.liveTerminals() ?? []
    return terminals.map((terminal, index) => ({
      id: `terminal:${terminal.terminalId}`,
      kind: 'terminal',
      title: t('终端 {value}', { value: index + 1 }),
      detail: projectName(terminal.projectPath),
      live: terminal.state === 'running'
    }))
  }

  subscribe(terminalId: string, listener: Listener): (() => void) | null {
    const terminal = this.source()
      ?.liveTerminals()
      .find((item) => item.terminalId === terminalId)
    if (!terminal) return null
    listener({
      type: 'replay',
      data: this.buffers.get(terminalId) ?? '',
      cols: terminal.cols,
      rows: terminal.rows,
      state: terminal.state
    })
    const set = this.listeners.get(terminalId) ?? new Set()
    set.add(listener)
    this.listeners.set(terminalId, set)
    return () => {
      set.delete(listener)
      if (!set.size) this.listeners.delete(terminalId)
    }
  }

  input(terminalId: string, input: RemoteTerminalInput): void {
    const data = input.type === 'text' ? input.data : REMOTE_TERMINAL_KEYS[input.key]
    if (!this.source()?.remoteInput(terminalId, data))
      throw new Error(t('终端当前不能输入：可能已结束、正在重连，或输入过快'))
  }

  private record(event: TerminalEvent): void {
    if (event.type === 'output') {
      const next = (this.buffers.get(event.terminalId) ?? '') + event.data
      this.buffers.set(
        event.terminalId,
        next.length > REPLAY_BYTES ? next.slice(next.length - REPLAY_BYTES) : next
      )
      for (const listener of this.listeners.get(event.terminalId) ?? [])
        listener({ type: 'output', data: event.data })
      return
    }
    const terminal = event.terminal
    for (const listener of this.listeners.get(terminal.terminalId) ?? [])
      listener({ type: 'state', cols: terminal.cols, rows: terminal.rows, state: terminal.state })
    if (terminal.exitConfirmed) this.buffers.delete(terminal.terminalId)
  }
}
