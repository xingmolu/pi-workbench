import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitReviewProcess } from './git-review-process'

function fixture() {
  const children: Array<ChildProcess & { stdout: PassThrough; stderr: PassThrough }> = []
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true)
    }) as unknown as ChildProcess & { stdout: PassThrough; stderr: PassThrough }
    children.push(child)
    return child
  })
  const runner = new GitReviewProcess({
    gitPath: '/usr/bin/git',
    hooksPath: '/host/empty-hooks',
    trustedEnv: {
      HOME: '/host/home',
      PATH: '/usr/bin:/bin',
      TMPDIR: '/tmp',
      GIT_DIR: '/evil',
      NODE_OPTIONS: '--inspect',
      ELECTRON_RUN_AS_NODE: '1'
    },
    spawn
  })
  return { runner, spawn, children }
}

describe('bounded host Git process', () => {
  afterEach(() => vi.useRealTimers())
  it('executes the trusted system Git in an isolated temporary directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'git-review-process-'))
    try {
      const hooksPath = join(root, 'hooks')
      await mkdir(hooksPath)
      const runner = new GitReviewProcess({
        gitPath: '/usr/bin/git',
        hooksPath,
        trustedEnv: { HOME: root, PATH: '/usr/bin:/bin', TMPDIR: root, LC_ALL: 'C' }
      })
      const result = await runner.run({ cwd: root, args: ['--version'], budget: 'status' })
      expect(result.ok && result.stdout.toString()).toMatch(/^git version /)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('rejects already-aborted and oversized requests without spawning', async () => {
    const { runner, spawn } = fixture()
    expect(
      await runner.run({ cwd: '/p', args: [], budget: 'status', signal: AbortSignal.abort() })
    ).toEqual({ ok: false, reason: 'aborted' })
    expect(await runner.run({ cwd: '/p', args: ['x'.repeat(65537)], budget: 'status' })).toEqual({
      ok: false,
      reason: 'invalid-request'
    })
    expect(spawn).not.toHaveBeenCalled()
  })
  it('times out a queued request without spawning it while occupied slots await close', async () => {
    vi.useFakeTimers()
    const { runner, children } = fixture()
    const first = runner.run({ cwd: '/p', args: [], budget: 'patch' })
    const second = runner.run({ cwd: '/p', args: [], budget: 'patch' })
    const queued = runner.run({ cwd: '/p', args: [], budget: 'status' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(await queued).toEqual({ ok: false, reason: 'timeout' })
    expect(children).toHaveLength(2)
    children.forEach((c) => c.emit('close', 0, null))
    await Promise.all([first, second])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('reports a signaled close and exit 1 distinctly', async () => {
    const { runner, children } = fixture()
    const signaled = runner.run({ cwd: '/p', args: [], budget: 'status' })
    children[0].emit('close', null, 'SIGTERM')
    expect(await signaled).toEqual({ ok: false, reason: 'signal', signal: 'SIGTERM' })
    const noMatch = runner.run({ cwd: '/p', args: [], budget: 'status' })
    children[1].emit('close', 1, null)
    expect(await noMatch).toEqual({ ok: false, reason: 'exit', exitCode: 1, stderrKind: 'other' })
  })
  it('converts synchronous spawn errors safely and handles stream errors until close', async () => {
    const runner = new GitReviewProcess({
      gitPath: '/usr/bin/git',
      hooksPath: '/host/hooks',
      trustedEnv: {},
      spawn: () => {
        throw new Error('secret')
      }
    })
    expect(await runner.run({ cwd: '/p', args: [], budget: 'status' })).toEqual({
      ok: false,
      reason: 'spawn'
    })
    const f = fixture()
    const result = f.runner.run({ cwd: '/p', args: [], budget: 'status' })
    f.children[0].stdout.emit('error', new Error('secret'))
    expect(f.children[0].kill).toHaveBeenCalledWith('SIGKILL')
    f.children[0].emit('close', null, 'SIGKILL')
    expect(await result).toEqual({ ok: false, reason: 'io' })
  })
  it('accepts exact caps and multiple chunks without losing bytes', async () => {
    const { runner, children } = fixture()
    const result = runner.run({ cwd: '/p', args: [], budget: 'patch' })
    children[0].stdout.write(Buffer.alloc(1024 * 1024, 65))
    children[0].stdout.write(Buffer.alloc(1024 * 1024, 66))
    children[0].stderr.write(Buffer.alloc(65536, 67))
    children[0].emit('close', 0, null)
    const value = await result
    expect(value.ok && value.stdout.length).toBe(2 * 1024 * 1024)
    expect(value.ok && value.stdout[1024 * 1024]).toBe(66)
  })
  it.each([
    ['status', 'stdout', 4 * 1024 * 1024],
    ['patch', 'stdout', 2 * 1024 * 1024],
    ['status', 'stderr', 64 * 1024]
  ] as const)(
    'kills %s on %s cap without accepting truncated output',
    async (budget, stream, cap) => {
      const { runner, children } = fixture()
      const result = runner.run({ cwd: '/project', args: ['status'], budget })
      children[0][stream].write(Buffer.alloc(cap + 1))
      expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')
      children[0].emit('close', null, 'SIGKILL')
      expect(await result).toEqual({ ok: false, reason: `${stream}-limit` })
      expect(children[0][stream].listenerCount('data')).toBe(0)
    }
  )
  it.each([
    ['status', 5000],
    ['patch', 10000]
  ] as const)('times out %s, but holds its slot until close', async (budget, timeout) => {
    vi.useFakeTimers()
    const { runner, children } = fixture()
    const result = runner.run({ cwd: '/project', args: [], budget })
    const settled = vi.fn()
    void result.then(settled)
    await vi.advanceTimersByTimeAsync(timeout)
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')
    expect(settled).not.toHaveBeenCalled()
    children[0].emit('close', null, 'SIGKILL')
    expect(await result).toEqual({ ok: false, reason: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds both active and queued requests, cancels queued work and drains on close', async () => {
    const { runner, children } = fixture()
    const controller = new AbortController()
    const first = runner.run({ cwd: '/p', args: [], budget: 'status' })
    const second = runner.run({ cwd: '/p', args: [], budget: 'status' })
    const third = runner.run({ cwd: '/p', args: [], budget: 'status', signal: controller.signal })
    const queued = Array.from({ length: 15 }, () =>
      runner.run({ cwd: '/p', args: [], budget: 'status' })
    )
    expect(children).toHaveLength(2)
    expect(await runner.run({ cwd: '/p', args: [], budget: 'status' })).toEqual({
      ok: false,
      reason: 'queue-full'
    })
    controller.abort()
    expect(await third).toEqual({ ok: false, reason: 'aborted' })
    for (let i = 0; i < 17; i++) children[i].emit('close', 0, null)
    expect((await Promise.all([first, second, ...queued])).every((r) => r.ok)).toBe(true)
  })
  it('aborts running work and removes abort and process listeners on close', async () => {
    const { runner, children } = fixture()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const result = runner.run({ cwd: '/p', args: [], budget: 'status', signal: controller.signal })
    controller.abort()
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')
    children[0].emit('close', null, 'SIGKILL')
    expect(await result).toEqual({ ok: false, reason: 'aborted' })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(children[0].eventNames()).toEqual([])
    expect(children[0].stderr.listenerCount('data')).toBe(0)
  })
  it('reports exit and spawn failures without exposing raw stderr or error messages', async () => {
    const { runner, children } = fixture()
    const result = runner.run({ cwd: '/p', args: [], budget: 'status' })
    children[0].stderr.write('fatal: not a git repository (or any parent): secret/path/token')
    children[0].emit('close', 128, null)
    expect(await result).toEqual({
      ok: false,
      reason: 'exit',
      exitCode: 128,
      stderrKind: 'not-repository'
    })
    const failed = runner.run({ cwd: '/p', args: [], budget: 'status' })
    children[1].emit('error', Object.assign(new Error('secret'), { code: 'ENOENT' }))
    expect(children[1].kill).toHaveBeenCalledWith('SIGKILL')
    children[1].emit('close', -2, null)
    expect(await failed).toEqual({ ok: false, reason: 'spawn', systemCode: 'ENOENT' })
  })
  it('uses a trusted executable, fixed safety prefix and controlled environment; resolves only at close', async () => {
    const { runner, spawn, children } = fixture()
    const result = runner.run({ cwd: '/project', args: ['status'], budget: 'status' })
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/git',
      [
        '--no-pager',
        '--no-optional-locks',
        '--literal-pathspecs',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/host/empty-hooks',
        '-c',
        'color.ui=false',
        'status'
      ],
      {
        cwd: '/project',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          HOME: '/host/home',
          PATH: '/usr/bin:/bin',
          TMPDIR: '/tmp',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_LAZY_FETCH: '1'
        }
      }
    )
    const settled = vi.fn()
    void result.then(settled)
    children[0].stdout.end('ok')
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    children[0].emit('close', 0, null)
    expect(await result).toEqual({ ok: true, stdout: Buffer.from('ok') })
  })
})
