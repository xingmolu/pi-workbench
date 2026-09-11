import { spawn } from 'node-pty'
import { isAbsolute } from 'node:path'
import { terminalHostCommandSchema, TERMINAL_LIMITS, type TerminalEvent } from '../shared/terminal'
import { TerminalSession } from './terminal-session'

// This entry is only launched by Main. There is no agent/plugin/renderer endpoint.
const parent = process.parentPort
if (!parent) throw new Error('Terminal Host requires its Main parent')
const sessions = new Map<string, TerminalSession>()
let shuttingDown = false
const fixture = process.argv.includes('--isolated-terminal-fixture')
const shell = process.env.SHELL && isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
const env: Record<string, string> = { TERM: 'xterm-256color', TERM_PROGRAM: 'PiDesktop' }
for (const key of [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE'
]) {
  const value = process.env[key]
  if (value) env[key] = value
}
if (fixture) env.ZDOTDIR = env.HOME
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
      spawn: () =>
        spawn(shell, fixture ? ['-f'] : ['-l'], {
          name: 'xterm-256color',
          cols: command.cols,
          rows: command.rows,
          cwd: command.projectPath,
          env,
          encoding: 'utf8',
          handleFlowControl: false
        })
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
