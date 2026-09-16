import { describe, expect, it } from 'vitest'
import {
  terminalEventSchema,
  terminalHostCommandSchema,
  type TerminalEvent
} from '../shared/terminal'
import { TerminalSession, type PtyPort } from './terminal-session'

const identity = {
  projectPath: '/tmp/project',
  terminalId: '00000000-0000-4000-8000-000000000001',
  generation: '00000000-0000-4000-8000-000000000002',
  connectionEpoch: 1
}
function fixture(nativeWriteThrows = false) {
  let data: (data: string) => void = () => undefined
  let exit: (event: { exitCode: number; signal?: number }) => void = () => undefined
  const writes: (string | Buffer)[] = []
  const signals: string[] = []
  let paused = false
  const pty: PtyPort = {
    onData: (listener) => {
      data = listener
      return { dispose() {} }
    },
    onExit: (listener) => {
      exit = listener
      return { dispose() {} }
    },
    pause: () => {
      paused = true
    },
    resume: () => {
      paused = false
    },
    write: (value) => {
      if (nativeWriteThrows) throw new Error('private native failure')
      writes.push(value)
    },
    resize() {},
    kill: (signal) => {
      signals.push(signal)
    }
  }
  const events: TerminalEvent[] = []
  const session = new TerminalSession(
    { ...identity, cols: 80, rows: 24 },
    { spawn: () => pty, emit: (e) => events.push(e), closeTimeoutMs: 10 }
  )
  session.start()
  return {
    session,
    events,
    writes,
    signals,
    data: (v: string) => data(v),
    exit: (code = 0) => exit({ exitCode: code }),
    paused: () => paused
  }
}
describe('PTY session', () => {
  it('native write failure produces a fixed visible failure and prevents later input', () => {
    const f = fixture(true)
    f.session.command({ type: 'attach', ...identity })
    expect(f.session.command({ type: 'input', ...identity, data: 'x' })).toBe(false)
    expect(f.session.metadata).toMatchObject({
      state: 'failed',
      failure: 'protocol',
      exitConfirmed: false
    })
    expect(JSON.stringify(f.events)).not.toContain('private native failure')
    expect(f.signals).toEqual(['SIGHUP'])
    f.exit()
  })
  it('bounds native input queue for a shell that never reads, across arbitrarily many rate windows', () => {
    const f = fixture()
    f.session.command({ type: 'attach', ...identity })
    for (let i = 0; i < 512; i++)
      expect(f.session.command({ type: 'input', ...identity, data: 'x'.repeat(16384) })).toBe(true)
    expect(f.session.command({ type: 'input', ...identity, data: 'x' })).toBe(false)
    expect(f.session.metadata.failure).toBe('input-limit')
    f.exit()
    const tiny = fixture()
    tiny.session.command({ type: 'attach', ...identity })
    for (let i = 0; i < 65536; i++) tiny.session.command({ type: 'input', ...identity, data: 'x' })
    expect(tiny.session.command({ type: 'input', ...identity, data: 'x' })).toBe(false)
    expect(tiny.session.metadata.failure).toBe('input-limit')
    tiny.exit()
  })
  it('emits schema-valid metadata when constructed from a parsed spawn envelope', () => {
    const command = terminalHostCommandSchema.parse({
      type: 'spawn',
      ...identity,
      cols: 80,
      rows: 24,
      degraded: false
    })
    if (command.type !== 'spawn') throw new Error('Expected spawn')
    const events: TerminalEvent[] = []
    const session = new TerminalSession(command, {
      spawn: () => {
        throw new Error('native private path')
      },
      emit: (e) => events.push(e)
    })
    session.start()
    expect(events.every((e) => terminalEventSchema.safeParse(e).success)).toBe(true)
    expect(events).toMatchObject([
      { type: 'state', terminal: { failure: 'spawn', exitConfirmed: true } }
    ])
    expect(JSON.stringify(events)).not.toContain('native private path')
  })
  it('revokes old consumer on reload and never resumes degraded management attach', () => {
    const f = fixture()
    f.session.command({ type: 'attach', ...identity })
    f.session.detach(2)
    expect(f.session.command({ type: 'input', ...identity, data: 'wrong' })).toBe(false)
    expect(f.session.command({ type: 'attach', ...identity, connectionEpoch: 2 })).toBe(true)
    expect(
      f.session.command({ type: 'resize', ...identity, connectionEpoch: 2, cols: 80, rows: 24 })
    ).toBe(false)
    expect(
      f.session.command({ type: 'input', ...identity, connectionEpoch: 2, data: 'wrong' })
    ).toBe(false)
    expect(f.paused()).toBe(true)
    expect(f.writes).toEqual([])
  })
  it('hard output overflow stops input and reports failure without claiming actual exit', async () => {
    const f = fixture()
    f.data('x'.repeat(1024 * 1024 + 1))
    await Promise.resolve()
    expect(f.session.metadata).toMatchObject({
      state: 'failed',
      failure: 'output-limit',
      exitConfirmed: false
    })
    expect(f.signals).toEqual(['SIGHUP'])
    f.exit(1)
    expect(f.session.metadata).toMatchObject({
      state: 'failed',
      failure: 'output-limit',
      exitConfirmed: true,
      exitCode: 1
    })
  })
  it('close is idempotent, waits for actual exit, and retains unconfirmed timeout', async () => {
    const f = fixture()
    f.session.command({ type: 'attach', ...identity })
    expect(f.session.command({ type: 'close', ...identity })).toBe(true)
    expect(f.session.command({ type: 'close', ...identity })).toBe(true)
    expect(f.session.command({ type: 'input', ...identity, data: 'late' })).toBe(false)
    await f.session.close()
    expect(f.signals).toEqual(['SIGHUP'])
    expect(f.session.metadata).toMatchObject({
      state: 'failed',
      failure: 'close-timeout',
      exitConfirmed: false
    })
    f.exit(129)
    expect(f.session.metadata.exitConfirmed).toBe(true)
  })
  it('preserves binary mouse bytes and accepts Main-approved bursts independent of host timing', () => {
    const f = fixture()
    f.session.command({ type: 'attach', ...identity })
    expect(
      f.session.command({ type: 'input', ...identity, encoding: 'binary', data: '\x80\xff' })
    ).toBe(true)
    expect(f.writes).toEqual([Buffer.from([128, 255])])
    expect(f.session.command({ type: 'input', ...identity, encoding: 'binary', data: '中' })).toBe(
      false
    )
    for (let i = 0; i < 5; i++)
      f.session.command({ type: 'input', ...identity, data: 'x'.repeat(16384) })
    expect(f.writes.length).toBe(6)
  })
  it('preserves split Unicode and VT bytes with bounded chunks and monotonic ACK backpressure', async () => {
    const f = fixture()
    f.session.command({ type: 'attach', ...identity })
    f.data('中'.repeat(100000) + '\uD83D')
    f.data('\uDE00\x1b[')
    f.data('31m')
    await Promise.resolve()
    expect(f.paused()).toBe(true)
    let output = f.events.filter((e) => e.type === 'output')
    expect(output.every((e) => Buffer.byteLength(e.data) <= 32768)).toBe(true)
    expect(f.session.command({ type: 'ack', ...identity, sequence: 9999 })).toBe(false)
    const last = output.at(-1)!.sequence
    expect(f.session.command({ type: 'ack', ...identity, sequence: last })).toBe(true)
    expect(f.session.command({ type: 'ack', ...identity, sequence: last })).toBe(false)
    await Promise.resolve()
    output = f.events.filter((e) => e.type === 'output')
    expect(output.map((e) => e.data).join('')).toBe('中'.repeat(100000) + '😀\x1b[31m')
    expect(f.paused()).toBe(false)
  })
  it('buffers early output until its matching consumer attaches', async () => {
    const f = fixture()
    f.data('prompt> ')
    await Promise.resolve()
    expect(f.paused()).toBe(true)
    expect(f.events.filter((e) => e.type === 'output')).toEqual([])
    expect(f.session.command({ type: 'attach', ...identity, connectionEpoch: 2 })).toBe(false)
    expect(f.session.command({ type: 'attach', ...identity })).toBe(true)
    await Promise.resolve()
    expect(f.events.filter((e) => e.type === 'output').map((e) => e.data)).toEqual(['prompt> '])
  })
})
