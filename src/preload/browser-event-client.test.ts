import { describe, expect, it, vi } from 'vitest'
import { createBrowserEventSubscriber, type BrowserEventTransport } from './browser-event-client'

describe('Browser preload event subscriber', () => {
  it('forwards only validated state events and removes its exact listener', () => {
    const listeners = new Set<(event: unknown) => void>()
    const transport: BrowserEventTransport = {
      onEvent(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
    const subscribe = createBrowserEventSubscriber(transport)
    const listener = vi.fn()
    const unsubscribe = subscribe(listener)
    const browserState = {
      available: true,
      visible: false,
      pages: [],
      activePageId: null,
      controller: 'idle' as const
    }

    listeners.forEach((emit) => emit({ type: 'agent-open' }))
    listeners.forEach((emit) => emit({ type: 'state', data: { ...browserState, extra: true } }))
    listeners.forEach((emit) => emit({ type: 'state', data: browserState }))

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ type: 'state', data: browserState })
    expect(listeners.size).toBe(1)
    unsubscribe()
    expect(listeners.size).toBe(0)
  })
})
