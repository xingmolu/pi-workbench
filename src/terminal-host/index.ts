import { spawn, type IPty } from 'node-pty'
import { isAbsolute } from 'node:path'
import { terminalHostCommandSchema, TERMINAL_LIMITS, type TerminalEvent } from '../shared/terminal'
import { TerminalSession } from './terminal-session'
import { resolveShell, shellArgs, shellName, terminalEnvironment } from '../shared/terminal-shell'

// This entry is only launched by Main. There is no agent/plugin/renderer endpoint.
const parent = process.parentPort
if (!parent) throw new Error('Terminal Host requires its Main parent')
const sessions = new Map<string, TerminalSession>()
let shuttingDown = false
const fixture = process.argv.includes('--isolated-terminal-fixture')
// Main resolved the shell and built the environment; the host only drops its own runtime.
const shell =
  process.env.SHELL && isAbsolute(process.env.SHELL)
    ? process.env.SHELL
    : resolveShell([], () => true)
const env = terminalEnvironment(process.env, { shell })
const args = shellArgs(shell, fixture)

/** Bytes node-pty has queued for the shell but not yet written, read defensively. */
function pendingWriteBytes(pty: IPty): number {
  const queue = (pty as unknown as { _writeStream?: { _writeQueue?: unknown } })._writeStream
    ?._writeQueue
  if (!Array.isArray(queue)) return 0
  let total = 0
  for (const task of queue as { buffer?: { byteLength?: number }; offset?: number }[])
    total += Math.max(0, (task.buffer?.byteLength ?? 0) - (task.offset ?? 0))
  return total
}
const emit = (event: TerminalEvent): void => parent.postMessage(event)

parent.on('message', ({ data }: { data: unknown }) => {
  const parsed = terminalHostCommandSchema.safeParse(data)
  if (!parsed.success || shuttingDown) return
  const command = parsed.data
  if (command.type === 'shutdown') {
    shuttingDown = true
    void Promise.all([...sessions.values()].map((session) => session.close())).finally(() =>
      process.exit(0)
    )
    return
  }
  if (command.type === 'spawn') {
    if (sessions.has(command.terminalId)) return
    const active = [...sessions.values()].filter((s) => !s.metadata.exitConfirmed)
    if (
      active.length >= TERMINAL_LIMITS.total ||
      active.filter((s) => s.metadata.projectPath === command.projectPath).length >=
        TERMINAL_LIMITS.perProject
    )
      return
    const session = new TerminalSession(command, {
      emit,
      shellName: shellName(shell),
      spawn: () => {
        const pty = spawn(shell, args, {
          name: 'xterm-256color',
          cols: command.cols,
          rows: command.rows,
          cwd: command.projectPath,
          env,
          encoding: 'utf8',
          handleFlowControl: false
        })
        return Object.assign(pty, {
          pendingWriteBytes: () => pendingWriteBytes(pty),
          // Windows has no signals; node-pty rejects one there and ends the console instead.
          ...(process.platform === 'win32' ? { kill: () => pty.kill() } : {})
        })
      }
    })
    // Registry precedes native start; immediate output/exit belongs to this identity.
    sessions.set(command.terminalId, session)
    if (command.degraded) {
      session.metadata.connection = 'management'
      session.metadata.state = 'degraded'
    }
    session.start()
    return
  }
  const identity = command.type === 'command' ? command.command : command
  if (!('terminalId' in identity)) return
  const session = sessions.get(identity.terminalId)
  if (
    !session ||
    identity.generation !== session.metadata.generation ||
    identity.projectPath !== session.metadata.projectPath
  )
    return
  if (command.type === 'detach') session.detach(command.connectionEpoch)
  else if (command.type === 'dismiss') {
    if (
      session.metadata.exitConfirmed &&
      identity.connectionEpoch === session.metadata.connectionEpoch
    )
      sessions.delete(identity.terminalId)
  } else if (!session.command(command.command)) {
    // A Main-forwarded rejection must never silently discard input while claiming running.
    session.rejectCommand()
  }
})
