import { expect, it, vi } from 'vitest'
import { createMobileLiveSubscriber } from './mobile-live-subscriber'
import type { MobileConversationSnapshot } from './mobile-gateway'

function fixture() {
  const sources: Array<{
    close: ReturnType<typeof vi.fn>
    emit(type: string, workerId?: string, state?: Partial<MobileConversationSnapshot>): void
  }> = []
  const pending: Array<(value: MobileConversationSnapshot) => void> = []
  const fetch = vi.fn(
    () => new Promise<MobileConversationSnapshot>((resolve) => pending.push(resolve))
  )
  const snapshot = vi.fn()
  const finished = vi.fn()
  const paused = vi.fn()
  const error = vi.fn()
  const subscriber = createMobileLiveSubscriber({
    source: () => {
      const listeners = new Map<string, (event: { data: string }) => void>()
      const source = {
        close: vi.fn(),
        addEventListener: (type: string, listener: (event: { data: string }) => void) => {
          listeners.set(type, listener)
        },
        emit: (type: string, workerId = 'a', state: Partial<MobileConversationSnapshot> = {}) =>
          listeners.get(type)?.({ data: JSON.stringify({ workerId, ...state }) })
      }
      sources.push(source)
      return source
    },
    fetch,
    snapshot,
    finished,
    paused,
    error
  })
  return { subscriber, sources, pending, fetch, snapshot, finished, paused, error }
}
const state = (workerId: string) => ({ workerId }) as MobileConversationSnapshot

it('closes oversize source, fetches once, preserves HTTP state and manually refreshes without reopening', async () => {
  const f = fixture()
  f.subscriber.watch('a')
  f.sources[0].emit('resync-required')
  f.sources[0].emit('resync-required')
  f.sources[0].emit('snapshot')
  f.sources[0].emit('run-finished')
  expect(f.fetch).toHaveBeenCalledTimes(1)
  expect(f.sources[0].close).toHaveBeenCalledTimes(1)
  expect(f.paused).toHaveBeenLastCalledWith(true)
  expect(f.snapshot).not.toHaveBeenCalled()
  expect(f.finished).not.toHaveBeenCalled()
  f.pending[0](state('a'))
  await f.subscriber.refresh()
  expect(f.snapshot).toHaveBeenCalledWith(state('a'))
  const manual = f.subscriber.refresh()
  expect(f.fetch).toHaveBeenCalledTimes(2)
  f.pending[1](state('a'))
  await manual
  expect(f.sources).toHaveLength(1)
})

it('rejects old source and HTTP callbacks across A to B to A view changes', async () => {
  const f = fixture()
  f.subscriber.watch('a')
  f.sources[0].emit('resync-required')
  const old = f.subscriber.refresh()
  f.subscriber.watch('b')
  f.subscriber.watch('a')
  f.sources[0].emit('snapshot')
  f.sources[0].emit('run-finished')
  f.sources[1].emit('snapshot', 'b')
  f.pending[0](state('a'))
  await old
  expect(f.snapshot).not.toHaveBeenCalled()
  expect(f.finished).not.toHaveBeenCalled()
  f.sources[2].emit('snapshot')
  f.sources[2].emit('run-finished')
  expect(f.snapshot).toHaveBeenCalledTimes(1)
  expect(f.finished).toHaveBeenCalledTimes(1)
})

it('does not replace newer SSE state with an older initial HTTP response', async () => {
  let deliver!: (event: { data: string }) => void
  let resolve!: (snapshot: MobileConversationSnapshot) => void
  const snapshot = vi.fn()
  const subscriber = createMobileLiveSubscriber({
    source: () => ({
      close() {},
      addEventListener(type, listener) {
        if (type === 'snapshot') deliver = listener
      }
    }),
    fetch: () =>
      new Promise((done) => {
        resolve = done
      }),
    snapshot,
    finished() {},
    paused() {},
    error() {}
  })
  subscriber.watch('a')
  const pending = subscriber.refresh()
  deliver({ data: JSON.stringify({ workerId: 'a', generation: 2, revision: 5 }) })
  resolve({ ...state('a'), generation: 2, revision: 4 })
  await pending
  expect(snapshot).toHaveBeenCalledTimes(1)
  expect(snapshot).toHaveBeenLastCalledWith({ workerId: 'a', generation: 2, revision: 5 })
})

it('fetches fresh state after a pre-existing HTTP request when the source requires resync', async () => {
  const f = fixture()
  f.subscriber.watch('a')
  const initial = f.subscriber.refresh()
  f.sources[0].emit('resync-required')
  expect(f.fetch).toHaveBeenCalledTimes(1)
  f.pending[0](state('a'))
  await initial
  expect(f.fetch).toHaveBeenCalledTimes(2)
  f.pending[1](state('a'))
  await f.subscriber.refresh()
  expect(f.sources).toHaveLength(1)
})

it.each([false, true])(
  'retains current live/paused state when navigation fails: paused=%s',
  async (paused) => {
    const f = fixture()
    f.subscriber.watch('a')
    if (paused) {
      f.sources[0].emit('resync-required')
      f.pending[0](state('a'))
      await f.subscriber.refresh()
    }
    const selected = vi.fn()
    const failure = new Error('B unavailable')
    await f.subscriber.navigate(() => Promise.reject(failure), selected)
    expect(selected).not.toHaveBeenCalled()
    expect(f.error).toHaveBeenCalledWith(failure)
    expect(f.sources).toHaveLength(1)
    expect(f.sources[0].close).toHaveBeenCalledTimes(paused ? 1 : 0)
    expect(f.paused).toHaveBeenLastCalledWith(paused)
    f.snapshot.mockClear()
    f.sources[0].emit('snapshot')
    expect(f.snapshot).toHaveBeenCalledTimes(paused ? 0 : 1)
  }
)

it.each(['reject', 'resolve'] as const)(
  'ignores a stale navigation %s after a newer selection',
  async (outcome) => {
    const f = fixture()
    f.subscriber.watch('a')
    let resolve!: (value: MobileConversationSnapshot) => void
    let reject!: (error: Error) => void
    const oldSelected = vi.fn()
    const old = f.subscriber.navigate(
      () =>
        new Promise<MobileConversationSnapshot>((done, fail) => {
          resolve = done
          reject = fail
        }),
      oldSelected
    )
    const selected = vi.fn((value: MobileConversationSnapshot) =>
      f.subscriber.watch(value.workerId)
    )
    await f.subscriber.navigate(() => Promise.resolve(state('c')), selected)
    if (outcome === 'reject') reject(new Error('old B failed'))
    else resolve(state('b'))
    await old
    expect(selected).toHaveBeenCalledWith(state('c'))
    expect(oldSelected).not.toHaveBeenCalled()
    expect(f.error).not.toHaveBeenCalled()
    f.sources[1].emit('snapshot', 'c')
    expect(f.snapshot).toHaveBeenLastCalledWith(state('c'))
  }
)

it('invalidates older navigation even when the newer navigation fails without changing the view', async () => {
  const f = fixture()
  f.subscriber.watch('a')
  let resolve!: (value: MobileConversationSnapshot) => void
  const selected = vi.fn()
  const old = f.subscriber.navigate(
    () =>
      new Promise<MobileConversationSnapshot>((done) => {
        resolve = done
      }),
    selected
  )
  const currentError = new Error('C failed')
  await f.subscriber.navigate(() => Promise.reject(currentError), selected)
  resolve(state('b'))
  await old
  expect(selected).not.toHaveBeenCalled()
  expect(f.error).toHaveBeenCalledExactlyOnceWith(currentError)
  expect(f.sources[0].close).not.toHaveBeenCalled()
})

it('retains a newer live revision when reselecting the same worker completes with older HTTP state', async () => {
  const f = fixture()
  f.subscriber.watch('a')
  let resolve!: (value: MobileConversationSnapshot) => void
  const selected = vi.fn()
  const request = f.subscriber.navigate(
    () =>
      new Promise<MobileConversationSnapshot>((done) => {
        resolve = done
      }),
    selected
  )
  f.sources[0].emit('snapshot', 'a', { generation: 2, revision: 5 })
  resolve({ ...state('a'), generation: 2, revision: 4 })
  await request
  expect(selected).toHaveBeenCalledWith({ workerId: 'a', generation: 2, revision: 5 })
})

it.each(['a', 'b'])(
  'seeds the accepted revision after navigation to worker %s',
  async (workerId) => {
    const f = fixture()
    f.subscriber.watch('a')
    f.sources[0].emit('snapshot', 'a', { generation: 2, revision: 5 })
    await f.subscriber.navigate(
      () => Promise.resolve({ ...state(workerId), generation: 2, revision: 6 }),
      (value) => f.subscriber.watch(value.workerId)
    )
    f.snapshot.mockClear()
    f.sources.at(-1)!.emit('snapshot', workerId, { generation: 2, revision: 5 })
    expect(f.snapshot).not.toHaveBeenCalled()
    f.sources.at(-1)!.emit('snapshot', workerId, { generation: 2, revision: 7 })
    expect(f.snapshot).toHaveBeenCalledWith({ workerId, generation: 2, revision: 7 })
  }
)
