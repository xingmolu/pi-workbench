import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchSnapshot } from '../shared/workbench-contracts'
import { createWorkbenchClient, type WorkbenchTransport } from './workbench-client'

const SNAPSHOT: WorkbenchSnapshot = {
  revision: 1,
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
  contributions: [
    {
      pluginId: 'works.pi.desktop.builtin',
      viewId: 'works.pi.desktop.files',
      title: 'Files',
      icon: 'files',
      activation: 'onProject',
      surface: { kind: 'first-party', adapter: 'files' }
    }
  ],
  diagnostics: []
}

function fakeTransport(): {
  value: WorkbenchTransport
  invoke: ReturnType<typeof vi.fn>
  emit: (value: unknown) => void
  listenerCount: () => number
} {
  const listeners = new Set<(value: unknown) => void>()
  const invoke = vi.fn(async (): Promise<unknown> => ({
    state: SNAPSHOT
  }))
  return {
    value: {
      invoke,
      onEvent: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    invoke,
    emit: (value) => {
      for (const listener of listeners) listener(value)
    },
    listenerCount: () => listeners.size
  }
}

describe('main Renderer Workbench preload client', () => {
  it('validates outbound commands and inbound command results', async () => {
    const fake = fakeTransport()
    const client = createWorkbenchClient(fake.value)

    await expect(client.workbench({ type: 'state:get' })).resolves.toEqual({ state: SNAPSHOT })
    expect(fake.invoke).toHaveBeenCalledWith({ type: 'state:get' })

    await expect(client.workbench({ type: 'view:set', viewId: '', visible: true })).rejects.toThrow(
      'invalid'
    )
    expect(fake.invoke).toHaveBeenCalledTimes(1)

    fake.invoke.mockResolvedValueOnce({ state: { ...SNAPSHOT, revision: -1 } })
    await expect(client.workbench({ type: 'state:get' })).rejects.toThrow('invalid')
  })

  it('validates inbound events and removes the exact listener', () => {
    const fake = fakeTransport()
    const client = createWorkbenchClient(fake.value)
    const listener = vi.fn()
    const unsubscribe = client.onWorkbenchEvent(listener)

    fake.emit({ type: 'state', data: { ...SNAPSHOT, revision: -1 } })
    expect(listener).not.toHaveBeenCalled()
    fake.emit({ type: 'reveal', viewId: 'works.pi.desktop.files' })
    expect(listener).toHaveBeenCalledWith({
      type: 'reveal',
      viewId: 'works.pi.desktop.files'
    })
    expect(fake.listenerCount()).toBe(1)

    unsubscribe()
    expect(fake.listenerCount()).toBe(0)
    fake.emit({ type: 'state', data: SNAPSHOT })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
