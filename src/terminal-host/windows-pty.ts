import type { PtyPort } from './terminal-session'

type ExitEvent = { exitCode: number; signal?: number }
type WindowsPty = Omit<PtyPort, 'kill' | 'process'> & {
  readonly pid: number
  kill(signal?: string): void
}

/** Exit code reported for a shell the console ended, the code Windows gives Ctrl+Break. */
const TERMINATED = 0xc000013a

/**
 * node-pty on Windows: there are no signals, `process` names the terminal type rather than
 * the foreground program, and after kill() it may never emit exit, because it stops reading
 * the console first. Kill without a signal, leave the foreground unknown, and confirm an exit
 * by the shell process actually being gone when node-pty does not report it.
 */
export function adaptWindowsPty(
  pty: WindowsPty,
  isAlive: (pid: number) => boolean = processAlive,
  pollMs = 50,
  giveUpMs = 10_000
): PtyPort {
  const listeners = new Set<(event: ExitEvent) => void>()
  let exited = false
  let poll: ReturnType<typeof setInterval> | undefined
  const exit = (event: ExitEvent): void => {
    if (exited) return
    exited = true
    clearInterval(poll)
    for (const listener of [...listeners]) listener(event)
  }
  pty.onExit(exit)
  return {
    onData: (listener) => pty.onData(listener),
    onExit(listener) {
      listeners.add(listener)
      return { dispose: () => void listeners.delete(listener) }
    },
    pause: () => pty.pause(),
    resume: () => pty.resume(),
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    pendingWriteBytes: pty.pendingWriteBytes?.bind(pty),
    process: undefined,
    kill() {
      pty.kill()
      if (exited || poll) return
      const started = Date.now()
      poll = setInterval(() => {
        if (!isAlive(pty.pid)) exit({ exitCode: TERMINATED })
        // Still running: leave it to the session's close timeout to report.
        else if (Date.now() - started > giveUpMs) clearInterval(poll)
      }, pollMs)
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
