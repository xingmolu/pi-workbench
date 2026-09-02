import { describe, expect, it, vi } from 'vitest'
import { loadAbortableWorkbenchPanel } from './workbench-panel-lifecycle'

type Deferred<Value> = {
  promise: Promise<Value>
  resolve: (value: Value) => void
}

function createDeferred<Value>(): Deferred<Value> {
  let resolvePromise!: (value: Value) => void
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

describe('Workbench panel load lifecycle', () => {
  it('stops and destroys immediately on abort and rejects a late load result', async () => {
    const controller = new AbortController()
    const load = createDeferred<void>()
    const stop = vi.fn()
    const destroy = vi.fn()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')

    const loading = loadAbortableWorkbenchPanel({
      signal: controller.signal,
      load: () => load.promise,
      stop,
      destroy
    })
    controller.abort(new Error('selection superseded'))

    expect(stop).toHaveBeenCalledTimes(1)
    expect(destroy).toHaveBeenCalledTimes(1)
    load.resolve()
    await expect(loading).rejects.toThrow(/selection superseded|abort/i)
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledTimes(1)
  })

  it('removes its abort listener after a successful load', async () => {
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const destroy = vi.fn()

    await loadAbortableWorkbenchPanel({
      signal: controller.signal,
      load: async () => undefined,
      stop: vi.fn(),
      destroy
    })

    expect(destroy).not.toHaveBeenCalled()
    expect(removeListener).toHaveBeenCalledTimes(1)
  })

  it('destroys once and removes its abort listener after load failure', async () => {
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const destroy = vi.fn()

    await expect(
      loadAbortableWorkbenchPanel({
        signal: controller.signal,
        load: async () => {
          throw new Error('load failed')
        },
        stop: vi.fn(),
        destroy
      })
    ).rejects.toThrow('load failed')

    expect(destroy).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledTimes(1)
  })
})
