import { afterEach, expect, it, vi } from 'vitest'
import { adaptWindowsPty } from './windows-pty'

afterEach(() => vi.useRealTimers())

function fakePty() {
  const exits: ((event: { exitCode: number }) => void)[] = []
  return {
    pid: 4242,
    kills: [] as (string | undefined)[],
    onData: () => ({ dispose() {} }),
    onExit(listener: (event: { exitCode: number }) => void) {
      exits.push(listener)
      return { dispose() {} }
    },
    pause() {},
    resume() {},
    write() {},
    resize() {},
    kill(signal?: string) {
      this.kills.push(signal)
    },
    exit: (exitCode: number) => exits.forEach((listener) => listener({ exitCode }))
  }
}

it('kills without a signal and leaves the foreground program unknown', () => {
  const pty = fakePty()
  const port = adaptWindowsPty(pty, () => true)
  expect(port.process).toBeUndefined()
  port.kill('SIGHUP')
  expect(pty.kills).toEqual([undefined])
})

it('confirms the exit once the shell is gone when node-pty never reports it', () => {
  vi.useFakeTimers()
  const pty = fakePty()
  let alive = true
  const port = adaptWindowsPty(pty, () => alive, 50, 10_000)
  const exits: number[] = []
  port.onExit(({ exitCode }) => exits.push(exitCode))
  port.kill('SIGHUP')
  vi.advanceTimersByTime(200)
  expect(exits).toEqual([])
  alive = false
  vi.advanceTimersByTime(50)
  expect(exits).toEqual([0xc000013a])
  pty.exit(0)
  expect(exits).toHaveLength(1)
})

it("reports node-pty's own exit once and stops watching a shell that outlives the window", () => {
  vi.useFakeTimers()
  const pty = fakePty()
  const port = adaptWindowsPty(pty, () => true, 50, 1_000)
  const exits: number[] = []
  port.onExit(({ exitCode }) => exits.push(exitCode))
  pty.exit(3)
  port.kill('SIGHUP')
  vi.advanceTimersByTime(5_000)
  expect(exits).toEqual([3])
  expect(vi.getTimerCount()).toBe(0)

  const stubborn = fakePty()
  adaptWindowsPty(stubborn, () => true, 50, 1_000).kill('SIGHUP')
  vi.advanceTimersByTime(1_100)
  expect(vi.getTimerCount()).toBe(0)
})
