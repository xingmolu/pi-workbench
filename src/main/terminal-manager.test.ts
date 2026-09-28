import { describe, expect, it, vi } from 'vitest'
import { TerminalManager, type TerminalTransport } from './terminal-manager'
import { TerminalSession, type PtyPort } from '../terminal-host/terminal-session'
import type {
  TerminalEvent,
  TerminalHostCommand,
  TerminalMetadata,
  TerminalResult
} from '../shared/terminal'

function fixture() {
  const sent: TerminalHostCommand[] = []
  const events: TerminalEvent[] = []
  let deliver: (v: unknown) => void = () => undefined
  let crash: () => void = () => undefined
  let diagnostic: () => void = () => undefined
  let release: () => void = () => undefined
  const port: TerminalTransport = { postMessage: (v) => sent.push(v), kill() {} }
  const ready = new Promise<TerminalTransport>((resolve) => {
    release = () => resolve(port)
  })
  const manager = new TerminalManager({
    canonicalProject: async (v) => v,
    startHost: (handlers) => {
      deliver = handlers.message
      crash = handlers.exit
      diagnostic = handlers.diagnostic
      return ready
    }
  })
  manager.registerWindow(1, (event) => events.push(event))
  manager.setProject('/tmp/a')
  return {
    manager,
    sent,
    events,
    deliver: (v: unknown) => deliver(v),
    crash: () => crash(),
    diagnostic: () => diagnostic(),
    release: () => release()
  }
}
function terminal(result: TerminalResult): TerminalMetadata {
  if (result.type !== 'terminal') throw new Error(`Expected terminal, got ${result.type}`)
  return result.terminal
}
const create = { type: 'create', projectPath: '/tmp/a', cols: 80, rows: 24 }
describe('Main terminal authority', () => {
  it.each([false, true])(
    'late attach cannot corrupt a closing real session (management=%s)',
    async (management) => {
      let session!: TerminalSession
      let nativeExit!: (event: { exitCode: number; signal?: number }) => void
      let resumes = 0
      const pty: PtyPort = {
        onData: () => ({ dispose() {} }),
        onExit: (listener) => {
          nativeExit = listener
          return { dispose() {} }
        },
        pause() {},
        resume() {
          resumes++
        },
        write() {},
        resize() {},
        kill() {}
      }
      const manager = new TerminalManager({
        canonicalProject: async (v) => v,
        startHost: async (handlers) => ({
          kill() {},
          postMessage(command) {
            if (command.type === 'spawn') {
              session = new TerminalSession(command, { spawn: () => pty, emit: handlers.message })
              session.start()
            } else if (command.type === 'detach') session.detach(command.connectionEpoch)
            else if (command.type === 'command' && !session.command(command.command))
              session.rejectCommand()
          }
        })
      })
      manager.registerWindow(1, () => undefined)
      manager.setProject('/tmp/a')
      const t = terminal(await manager.dispatch(1, create))
      const identity = {
        projectPath: t.projectPath,
        terminalId: t.terminalId,
        generation: t.generation,
        connectionEpoch: t.connectionEpoch
      }
      await manager.dispatch(1, { type: 'attach', ...identity })
      if (management) {
        manager.invalidateWindow(1)
        manager.registerWindow(1, () => undefined)
        identity.connectionEpoch++
        await manager.dispatch(1, { type: 'attach', ...identity })
      }
      try {
        await manager.dispatch(1, { type: 'close', ...identity })
        const before = resumes
        const lateAttach = await manager.dispatch(1, { type: 'attach', ...identity })
        expect(session.metadata).toMatchObject({ state: 'closing', failure: null })
        expect(lateAttach).toMatchObject({ type: 'unavailable' })
        expect(resumes).toBe(before)
        nativeExit({ exitCode: 0 })
        expect(await manager.dispatch(1, { type: 'list', projectPath: '/tmp/a' })).toMatchObject({
          terminals: [{ state: 'exited', failure: null, exitConfirmed: true, exitCode: 0 }]
        })
        expect(await manager.dispatch(1, { type: 'attach', ...identity })).toMatchObject({
          type: 'terminal',
          terminal: { state: 'exited', failure: null }
        })
        expect(resumes).toBe(before)
      } finally {
        if (!session.metadata.exitConfirmed) nativeExit({ exitCode: 0 })
      }
    }
  )
  it('unexpected utility diagnostics fail all owned sessions and request bounded shutdown without exposing payload', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      f.release()
      const t = terminal(await f.manager.dispatch(1, create))
      await f.manager.dispatch(1, create)
      f.diagnostic()
      f.diagnostic()
      const listed = await f.manager.dispatch(1, { type: 'list', projectPath: '/tmp/a' })
      expect(listed).toMatchObject({
        type: 'list',
        terminals: [
          { failure: 'host-io', state: 'failed', exitConfirmed: false },
          { failure: 'host-io', state: 'failed', exitConfirmed: false }
        ]
      })
      expect(
        await f.manager.dispatch(1, {
          type: 'input',
          projectPath: t.projectPath,
          terminalId: t.terminalId,
          generation: t.generation,
          connectionEpoch: t.connectionEpoch,
          data: 'late'
        })
      ).toMatchObject({ type: 'unavailable' })
      await Promise.resolve()
      expect(f.sent.filter((command) => command.type === 'shutdown')).toHaveLength(1)
      f.deliver({
        type: 'state',
        terminal: { ...t, state: 'exited', failure: null, exitConfirmed: true, exitCode: 0 }
      })
      expect(await f.manager.dispatch(1, { type: 'list', projectPath: '/tmp/a' })).toMatchObject({
        terminals: [
          { state: 'failed', failure: 'host-io', exitConfirmed: true },
          { failure: 'host-io', exitConfirmed: false }
        ]
      })
      await vi.advanceTimersByTimeAsync(2500)
      expect(await f.manager.dispatch(1, { type: 'list', projectPath: '/tmp/a' })).toMatchObject({
        terminals: [
          { failure: 'host-io', exitConfirmed: true },
          { failure: 'host-io', exitConfirmed: false }
        ]
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('revokes a create awaiting canonicalization when its window closes and a new window opens', async () => {
    let resolvePath!: (path: string) => void
    const startHost = vi.fn(async () => ({ postMessage: vi.fn(), kill() {} }))
    const manager = new TerminalManager({
      canonicalProject: () =>
        new Promise((resolve) => {
          resolvePath = resolve
        }),
      startHost
    })
    manager.registerWindow(1, () => undefined)
    manager.setProject('/tmp/a')
    const creating = manager.dispatch(1, create)
    await manager.shutdown()
    manager.registerWindow(2, () => undefined)
    resolvePath('/tmp/a')
    expect(await creating).toMatchObject({
      type: 'terminal',
      terminal: { state: 'failed', exitConfirmed: true }
    })
    expect(startHost).not.toHaveBeenCalled()
  })
  it('allows a same-owner reload during canonicalization to start only a degraded terminal', async () => {
    let resolvePath!: (path: string) => void
    const sent: TerminalHostCommand[] = []
    const manager = new TerminalManager({
      canonicalProject: () =>
        new Promise((resolve) => {
          resolvePath = resolve
        }),
      startHost: async () => ({ postMessage: (command) => sent.push(command), kill() {} })
    })
    manager.registerWindow(1, () => undefined)
    manager.setProject('/tmp/a')
    const creating = manager.dispatch(1, create)
    manager.invalidateWindow(1)
    resolvePath('/tmp/a')
    expect(await creating).toMatchObject({
      type: 'terminal',
      terminal: { state: 'degraded', connection: 'management', connectionEpoch: 2 }
    })
    expect(sent).toMatchObject([{ type: 'spawn', degraded: true, connectionEpoch: 2 }])
  })
  it('a new user create can retry host startup after a rejected launch', async () => {
    let attempts = 0
    const manager = new TerminalManager({
      canonicalProject: async (v) => v,
      startHost: async () => {
        if (++attempts === 1) throw new Error('Launch failed')
        return { postMessage() {}, kill() {} }
      }
    })
    manager.registerWindow(1, () => undefined)
    manager.setProject('/tmp/a')
    expect(await manager.dispatch(1, create)).toMatchObject({
      type: 'terminal',
      terminal: { failure: 'spawn', exitConfirmed: true }
    })
    expect(await manager.dispatch(1, create)).toMatchObject({
      type: 'terminal',
      terminal: { failure: null }
    })
    expect(attempts).toBe(2)
  })
  it('closeAll asks the host to close every live terminal once', async () => {
    const f = fixture()
    f.release()
    const first = terminal(await f.manager.dispatch(1, create))
    const second = terminal(await f.manager.dispatch(1, create))
    f.sent.length = 0

    f.manager.closeAll()
    f.manager.closeAll()

    const closed = f.sent.flatMap((message) =>
      message.type === 'command' && message.command.type === 'close'
        ? [message.command.terminalId]
        : []
    )
    expect(closed).toEqual([first.terminalId, second.terminalId])
    const listed = await f.manager.dispatch(1, { type: 'list', projectPath: '/tmp/a' })
    expect(listed.type === 'list' && listed.terminals.map(({ state }) => state)).toEqual([
      'closing',
      'closing'
    ])
  })
  it('keeps background consumer I/O bound to its original project and rejects forged identities', async () => {
    const f = fixture()
    f.release()
    const t = terminal(await f.manager.dispatch(1, create))
    const cap = {
      projectPath: t.projectPath,
      terminalId: t.terminalId,
      generation: t.generation,
      connectionEpoch: t.connectionEpoch
    }
    expect(await f.manager.dispatch(1, { type: 'attach', ...cap })).toMatchObject({
      type: 'terminal'
    })
    f.deliver({ type: 'state', terminal: { ...t, state: 'running', connection: 'consumer' } })
    f.manager.setProject('/tmp/b')
    expect(await f.manager.dispatch(1, { type: 'input', ...cap, data: '\x1b[0n' })).toEqual({
      type: 'ok'
    })
    for (const bad of [
      { terminalId: '00000000-0000-4000-8000-000000000099' },
      { projectPath: '/tmp/b' },
      { generation: '00000000-0000-4000-8000-000000000099' },
      { connectionEpoch: 99 }
    ]) {
      expect(
        await f.manager.dispatch(1, { type: 'input', ...cap, ...bad, data: 'x' })
      ).toMatchObject({ type: 'unavailable' })
    }
    expect(await f.manager.dispatch(1, { type: 'close', ...cap })).toMatchObject({
      type: 'unavailable'
    })
    expect(f.sent.at(-1)).toMatchObject({
      type: 'command',
      command: { type: 'input', projectPath: '/tmp/a' }
    })
  })
  it('invalidates reload connections synchronously, then allows only management attach', async () => {
    const f = fixture()
    f.release()
    const t = terminal(await f.manager.dispatch(1, create))
    const cap = {
      projectPath: t.projectPath,
      terminalId: t.terminalId,
      generation: t.generation,
      connectionEpoch: 1
    }
    await f.manager.dispatch(1, { type: 'attach', ...cap })
    f.manager.invalidateWindow(1)
    expect(await f.manager.dispatch(1, { type: 'ack', ...cap, sequence: 1 })).toMatchObject({
      type: 'unavailable'
    })
    f.manager.registerWindow(1, (e) => f.events.push(e))
    const listed = await f.manager.dispatch(1, { type: 'list', projectPath: '/tmp/a' })
    expect(listed).toMatchObject({
      type: 'list',
      terminals: [{ state: 'degraded', connectionEpoch: 2 }]
    })
    const newCap = { ...cap, connectionEpoch: 2 }
    expect(await f.manager.dispatch(1, { type: 'attach', ...newCap })).toMatchObject({
      type: 'terminal',
      terminal: { connection: 'management' }
    })
    expect(await f.manager.dispatch(1, { type: 'input', ...newCap, data: 'x' })).toMatchObject({
      type: 'unavailable'
    })
    expect(await f.manager.dispatch(1, { type: 'close', ...newCap })).toMatchObject({
      type: 'terminal',
      terminal: { state: 'closing' }
    })
  })
  it('does not adopt forged host ownership and rejects future/duplicate ACKs', async () => {
    const f = fixture()
    f.release()
    const t = terminal(await f.manager.dispatch(1, create))
    const cap = {
      projectPath: t.projectPath,
      terminalId: t.terminalId,
      generation: t.generation,
      connectionEpoch: 1
    }
    await f.manager.dispatch(1, { type: 'attach', ...cap })
    const output = { type: 'output', ...cap, sequence: 1, data: 'one' }
    f.deliver({ ...output, projectPath: '/tmp/b' })
    expect(f.events.filter((e) => e.type === 'output')).toHaveLength(0)
    f.deliver(output)
    expect(f.events.filter((e) => e.type === 'output')).toHaveLength(1)
    expect(await f.manager.dispatch(1, { type: 'ack', ...cap, sequence: 2 })).toMatchObject({
      type: 'unavailable'
    })
    expect(await f.manager.dispatch(1, { type: 'ack', ...cap, sequence: 1 })).toEqual({
      type: 'ok'
    })
    expect(await f.manager.dispatch(1, { type: 'ack', ...cap, sequence: 1 })).toMatchObject({
      type: 'unavailable'
    })
  })
  it('preserves original project during startup and retains failed host slots until proven exit', async () => {
    const f = fixture()
    const pending = f.manager.dispatch(1, create)
    f.manager.setProject('/tmp/b')
    f.release()
    const t = terminal(await pending)
    expect(t).toMatchObject({ projectPath: '/tmp/a', connection: 'unattached' })
    const cap = {
      projectPath: t.projectPath,
      terminalId: t.terminalId,
      generation: t.generation,
      connectionEpoch: 1
    }
    expect(await f.manager.dispatch(1, { type: 'attach', ...cap })).toMatchObject({
      type: 'unavailable'
    })
    f.crash()
    f.manager.setProject('/tmp/a')
    expect(await f.manager.dispatch(1, { type: 'list', projectPath: '/tmp/a' })).toMatchObject({
      terminals: [{ state: 'failed', exitConfirmed: false, failure: 'host-exit' }]
    })
    expect(await f.manager.dispatch(1, { type: 'close', ...cap })).toMatchObject({
      type: 'terminal',
      terminal: { exitConfirmed: false }
    })
  })
  it('reserves concurrent creates before async startup and rejects untrusted owners', async () => {
    const f = fixture()
    expect(await f.manager.dispatch(2, create)).toMatchObject({ type: 'unavailable' })
    const pending = Array.from({ length: 5 }, () => f.manager.dispatch(1, create))
    f.release()
    const results = await Promise.all(pending)
    expect(results.filter((r) => r.type === 'terminal')).toHaveLength(4)
    expect(f.sent.filter((r) => r.type === 'spawn')).toHaveLength(4)
  })
  it('caps the entire application across projects and preserves unconfirmed crash reservations', async () => {
    const f = fixture()
    f.release()
    for (const projectPath of ['/tmp/a', '/tmp/b']) {
      f.manager.setProject(projectPath)
      const results = await Promise.all(
        Array.from({ length: 4 }, () => f.manager.dispatch(1, { ...create, projectPath }))
      )
      expect(results.every((r) => r.type === 'terminal')).toBe(true)
    }
    f.crash()
    f.manager.setProject('/tmp/c')
    expect(await f.manager.dispatch(1, { ...create, projectPath: '/tmp/c' })).toMatchObject({
      type: 'unavailable'
    })
  })
  it('records an immediate native exit before the create call returns', async () => {
    let emit!: (v: unknown) => void
    const manager = new TerminalManager({
      canonicalProject: async (v) => v,
      startHost: async (h) => {
        emit = h.message
        return {
          kill() {},
          postMessage(command) {
            if (command.type === 'spawn')
              emit({
                type: 'state',
                terminal: {
                  projectPath: command.projectPath,
                  terminalId: command.terminalId,
                  generation: command.generation,
                  connectionEpoch: command.connectionEpoch,
                  cols: command.cols,
                  rows: command.rows,
                  state: 'exited',
                  connection: 'unattached',
                  exitCode: 7,
                  signal: null,
                  failure: null,
                  exitConfirmed: true
                }
              })
          }
        }
      }
    })
    manager.registerWindow(1, () => undefined)
    manager.setProject('/tmp/a')
    expect(await manager.dispatch(1, create)).toMatchObject({
      type: 'terminal',
      terminal: { state: 'exited', exitCode: 7, exitConfirmed: true }
    })
  })
  it('late running state cannot resurrect closing, and confirmed history is bounded', async () => {
    const f = fixture()
    f.release()
    for (let index = 0; index < 40; index++) {
      const t = terminal(await f.manager.dispatch(1, create))
      const cap = {
        projectPath: t.projectPath,
        terminalId: t.terminalId,
        generation: t.generation,
        connectionEpoch: 1
      }
      await f.manager.dispatch(1, { type: 'close', ...cap })
      f.deliver({ type: 'state', terminal: { ...t, state: 'running' } })
      const listed = await f.manager.dispatch(1, { type: 'list', projectPath: '/tmp/a' })
      expect(listed.type === 'list' && listed.terminals.at(-1)?.state).toBe('closing')
      f.deliver({
        type: 'state',
        terminal: { ...t, state: 'exited', exitConfirmed: true, exitCode: 0 }
      })
    }
    const listed = await f.manager.dispatch(1, { type: 'list', projectPath: '/tmp/a' })
    expect(listed.type === 'list' && listed.terminals.length).toBe(32)
    expect(f.sent.filter((command) => command.type === 'dismiss')).toHaveLength(8)
  })
  it('shutdown during startup remains bounded and kills a late stubborn host without spawning', async () => {
    vi.useFakeTimers()
    try {
      let release!: (port: TerminalTransport) => void
      const kill = vi.fn()
      const send = vi.fn()
      const manager = new TerminalManager({
        canonicalProject: async (v) => v,
        startHost: () =>
          new Promise((resolve) => {
            release = resolve
          })
      })
      manager.registerWindow(1, () => undefined)
      manager.setProject('/tmp/a')
      const creating = manager.dispatch(1, create)
      await Promise.resolve()
      const closing = manager.shutdown()
      manager.registerWindow(2, () => undefined)
      expect(await manager.dispatch(2, create)).toMatchObject({ type: 'unavailable' })
      await vi.advanceTimersByTimeAsync(2500)
      await closing
      release({ postMessage: send, kill })
      await creating
      await Promise.resolve()
      expect(kill).toHaveBeenCalledOnce()
      expect(send.mock.calls.some(([command]) => command.type === 'spawn')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
