import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchEvent, WorkbenchSnapshot } from '../../../shared/contracts'
import { startWorkbenchEventCoordinator } from './workbench-event-coordinator'
import { INITIAL_WORKBENCH_STATUS, workbenchStatusReducer } from './workbench-status'

function snapshot(
  revision: number,
  viewIds: string[] = ['works.pi.desktop.files']
): WorkbenchSnapshot {
  return {
    revision,
    plugins: [
      {
        pluginId: 'works.pi.desktop.builtin',
        name: 'Pi Desktop',
        version: '0.1.0',
        source: 'builtin',
        scope: 'builtin',
        builtin: true,
        desktopEnabled: true,
        hasExecutablePiResources: false,
        requestedPermissions: [],
        diagnostics: []
      }
    ],
    contributions: viewIds.map((viewId) => ({
      pluginId: 'works.pi.desktop.builtin',
      viewId,
      title: viewId,
      icon: 'files',
      activation: 'onApp',
      surface: { kind: 'first-party', adapter: 'files' }
    })),
    diagnostics: []
  }
}

function deferred<Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: Value) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('App Workbench event coordinator', () => {
  it('subscribes before state:get and does not let its late response replace a newer event', async () => {
    const order: string[] = []
    const initial = deferred<{ state: WorkbenchSnapshot }>()
    let emit!: (event: WorkbenchEvent) => void
    const onSnapshot = vi.fn((state: WorkbenchSnapshot) => order.push(`snapshot:${state.revision}`))

    startWorkbenchEventCoordinator({
      subscribe: (listener) => {
        order.push('subscribe')
        emit = listener
        return vi.fn()
      },
      getState: () => {
        order.push('state:get')
        return initial.promise
      },
      onSnapshot,
      onReveal: vi.fn(),
      onError: vi.fn()
    })

    expect(order).toEqual(['subscribe', 'state:get'])
    emit({ type: 'state', data: snapshot(2) })
    initial.resolve({ state: snapshot(1) })
    await initial.promise
    await Promise.resolve()

    expect(onSnapshot.mock.calls.map(([state]) => state.revision)).toEqual([2])
  })

  it('queues a reveal before bootstrap and applies it strictly after the refreshed snapshot', async () => {
    const initial = deferred<{ state: WorkbenchSnapshot }>()
    const order: string[] = []
    let emit!: (event: WorkbenchEvent) => void

    startWorkbenchEventCoordinator({
      subscribe: (listener) => {
        emit = listener
        return vi.fn()
      },
      getState: () => initial.promise,
      onSnapshot: (state) => order.push(`snapshot:${state.revision}`),
      onReveal: (viewId) => order.push(`reveal:${viewId}`),
      onError: vi.fn()
    })

    emit({ type: 'reveal', viewId: 'works.pi.browser.view' })
    expect(order).toEqual([])

    initial.resolve({ state: snapshot(1, ['works.pi.browser.view']) })
    await initial.promise
    await Promise.resolve()

    expect(order).toEqual(['snapshot:1', 'reveal:works.pi.browser.view'])
  })

  it('ignores absent reveals both before and after the initial snapshot', async () => {
    let emit!: (event: WorkbenchEvent) => void
    const onReveal = vi.fn()
    const ready = deferred<{ state: WorkbenchSnapshot }>()

    startWorkbenchEventCoordinator({
      subscribe: (listener) => {
        emit = listener
        return vi.fn()
      },
      getState: () => ready.promise,
      onSnapshot: vi.fn(),
      onReveal,
      onError: vi.fn()
    })

    emit({ type: 'reveal', viewId: 'missing.before' })
    ready.resolve({ state: snapshot(1) })
    await ready.promise
    await Promise.resolve()
    emit({ type: 'reveal', viewId: 'missing.after' })

    expect(onReveal).not.toHaveBeenCalled()
  })

  it('surfaces bootstrap failure and refreshes state for a later pre-snapshot reveal', async () => {
    let emit!: (event: WorkbenchEvent) => void
    const refreshed = deferred<{ state: WorkbenchSnapshot }>()
    const getState = vi
      .fn<() => Promise<{ state: WorkbenchSnapshot }>>()
      .mockRejectedValueOnce(new Error('Workbench 尚未就绪'))
      .mockReturnValueOnce(refreshed.promise)
    const onError = vi.fn()
    const order: string[] = []
    let status = INITIAL_WORKBENCH_STATUS

    startWorkbenchEventCoordinator({
      subscribe: (listener) => {
        emit = listener
        return vi.fn()
      },
      getState,
      onSnapshot: (state) => {
        status = workbenchStatusReducer(status, { type: 'snapshot', snapshot: state })
        order.push(`snapshot:${state.revision}`)
      },
      onReveal: (viewId) => order.push(`reveal:${viewId}`),
      onError: (message) => {
        status = workbenchStatusReducer(status, { type: 'error', message })
        onError(message)
      }
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(onError).toHaveBeenCalledWith('Workbench 尚未就绪')
    expect(status.error).toBe('工作台：Workbench 尚未就绪')
    emit({ type: 'reveal', viewId: 'works.pi.browser.view' })
    expect(getState).toHaveBeenCalledTimes(2)
    refreshed.resolve({ state: snapshot(1, ['works.pi.browser.view']) })
    await refreshed.promise
    await Promise.resolve()

    expect(order).toEqual(['snapshot:1', 'reveal:works.pi.browser.view'])
    expect(status.error).toBeNull()
  })

  it('unsubscribes and cancels all late callbacks, including bootstrap errors', async () => {
    let emit!: (event: WorkbenchEvent) => void
    const unsubscribe = vi.fn()
    const ready = deferred<{ state: WorkbenchSnapshot }>()
    const onSnapshot = vi.fn()
    const onReveal = vi.fn()
    const onError = vi.fn()

    const cleanup = startWorkbenchEventCoordinator({
      subscribe: (listener) => {
        emit = listener
        return unsubscribe
      },
      getState: () => ready.promise,
      onSnapshot,
      onReveal,
      onError
    })

    emit({ type: 'state', data: snapshot(1) })
    expect(onSnapshot).toHaveBeenCalledOnce()
    onSnapshot.mockClear()
    cleanup()
    cleanup()
    emit({ type: 'state', data: snapshot(1) })
    emit({ type: 'reveal', viewId: 'works.pi.desktop.files' })
    ready.reject(new Error('late bootstrap failure'))
    await ready.promise.catch(() => undefined)
    await Promise.resolve()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(onSnapshot).not.toHaveBeenCalled()
    expect(onReveal).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
})
