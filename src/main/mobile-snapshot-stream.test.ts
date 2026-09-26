import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileSnapshotStream } from './mobile-snapshot-stream'

class Transport extends EventEmitter {
  writableEnded = false
  destroyed = false
  acceptMore = true
  frames: string[] = []
  end(): void {
    this.writableEnded = true
    this.emit('close')
  }
  destroy(): void {
    this.destroyed = true
    this.emit('close')
  }
  write(chunk: string): boolean {
    this.frames.push(chunk)
    return this.acceptMore
  }
}

describe('mobile snapshot delivery', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces streaming bursts before serializing and flushes final content immediately', () => {
    const transport = new Transport()
    const stream = new MobileSnapshotStream(transport, 'worker')
    const serialize = vi.fn((revision: number) => JSON.stringify({ revision }))
    for (let revision = 1; revision <= 10; revision++) stream.publish(() => serialize(revision))
    expect(serialize).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(serialize.mock.calls).toEqual([[10]])
    stream.publish(() => serialize(11))
    stream.publish(() => serialize(12), true, true)
    expect(serialize.mock.calls).toEqual([[10], [12]])
    expect(transport.frames[1]).toBe(
      'event: snapshot\ndata: {"revision":12}\n\nevent: run-finished\ndata: {"workerId":"worker"}\n\n'
    )
    vi.advanceTimersByTime(200)
    expect(transport.frames).toHaveLength(2)
    stream.dispose()
  })

  it('does not serialize or write while blocked, retains completion, and resumes with latest state', () => {
    const transport = new Transport()
    transport.acceptMore = false
    const stream = new MobileSnapshotStream(transport, 'worker')
    stream.publish(() => 'initial', true)
    const serialize = vi.fn((revision: number) => JSON.stringify({ revision }))
    for (let revision = 1; revision <= 1000; revision++)
      stream.publish(() => serialize(revision), true, revision === 500)
    vi.advanceTimersByTime(1000)
    expect(serialize).not.toHaveBeenCalled()
    expect(transport.frames).toHaveLength(1)
    transport.acceptMore = true
    transport.emit('drain')
    expect(serialize.mock.calls).toEqual([[1000]])
    expect(transport.frames[1]).toContain('"revision":1000')
    expect(transport.frames[1]).toContain('event: run-finished')
    transport.emit('drain')
    expect(transport.frames).toHaveLength(2)
    stream.dispose()
  })

  it('cancels pending serialization and listeners when a connection closes', () => {
    const transport = new Transport()
    const stream = new MobileSnapshotStream(transport, 'worker')
    const serialize = vi.fn(() => 'late')
    stream.publish(serialize)
    transport.emit('close')
    vi.advanceTimersByTime(200)
    stream.publish(serialize, true)
    expect(serialize).not.toHaveBeenCalled()
    expect(transport.listenerCount('drain')).toBe(0)
    expect(transport.listenerCount('close')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

it('bounds UTF8 frames and terminates with a worker-scoped recovery notice', () => {
  const transport = new Transport()
  const stream = new MobileSnapshotStream(transport, 'worker', { maxFrameBytes: 100 })
  const serialize = vi.fn(() => '界'.repeat(40))
  stream.publish(serialize, true)
  stream.publish(serialize, true)
  expect(serialize).toHaveBeenCalledTimes(1)
  expect(transport.frames).toHaveLength(1)
  expect(transport.frames[0]).toContain('event: resync-required')
  expect(transport.frames[0]).toContain('"workerId":"worker"')
  expect(transport.writableEnded).toBe(true)
})

it('destroys a blocked connection on deadline without serializing pending state', () => {
  vi.useFakeTimers()
  const transport = new Transport()
  transport.acceptMore = false
  const stream = new MobileSnapshotStream(transport, 'worker', { backpressureTimeoutMs: 100 })
  stream.publish(() => 'first', true)
  const pending = vi.fn(() => 'last')
  stream.publish(pending, true, true)
  vi.advanceTimersByTime(100)
  expect(transport.destroyed).toBe(true)
  expect(pending).not.toHaveBeenCalled()
  expect(transport.listenerCount('drain')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})

it('bounds the lifetime of an oversized terminal notice on a blocked socket', () => {
  vi.useFakeTimers()
  const transport = new Transport()
  transport.acceptMore = false
  transport.end = () => {
    transport.writableEnded = true
  }
  const stream = new MobileSnapshotStream(transport, 'worker', {
    maxFrameBytes: 100,
    backpressureTimeoutMs: 100
  })
  stream.publish(() => 'x'.repeat(101), true)
  expect(transport.frames[0]).toContain('resync-required')
  stream.publish(() => {
    throw new Error('must not serialize')
  }, true)
  vi.advanceTimersByTime(100)
  expect(transport.destroyed).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})

it.each(['serialize', 'write'])('cleans up a %s failure from the timer callback', (failure) => {
  vi.useFakeTimers()
  const transport = new Transport()
  const stream = new MobileSnapshotStream(transport, 'worker')
  if (failure === 'write')
    transport.write = () => {
      throw new Error('write failed')
    }
  stream.publish(() => {
    if (failure === 'serialize') throw new Error('serialize failed')
    return 'state'
  })
  expect(() => vi.advanceTimersByTime(200)).not.toThrow()
  expect(transport.destroyed).toBe(true)
  expect(transport.listenerCount('drain')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})
