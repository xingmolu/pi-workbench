import { describe, expect, it, vi } from 'vitest'
import type {
  PluginPanelCommand,
  PluginPanelCommandResult,
  PluginPanelContext
} from '../shared/workbench-contracts'
import {
  createPiDesktopPluginBridge,
  createPluginPanelClient,
  type PluginPanelTransport
} from './plugin-client'

const CONTEXT: PluginPanelContext = {
  pluginId: 'acme.notes',
  viewId: 'acme.notes.panel',
  projectPath: '/workspace/project',
  sessionId: 'session-1',
  generation: 7
}

function transport(
  respond: (command: PluginPanelCommand) => unknown = (command): PluginPanelCommandResult => {
    if (command.type === 'context:get') return { type: 'context', context: CONTEXT }
    if (command.type === 'state:get') {
      return { type: 'state', context: command.context, value: { selected: 2 } }
    }
    return { type: 'state:stored', context: command.context }
  }
): {
  value: PluginPanelTransport
  invoke: ReturnType<typeof vi.fn>
  emit: (value: unknown) => void
  listenerCount: () => number
} {
  const listeners = new Set<(value: unknown) => void>()
  const invoke = vi.fn(async (command: PluginPanelCommand) => respond(command))
  return {
    value: {
      invoke,
      onContext: (listener) => {
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

describe('plugin panel preload client', () => {
  it('exposes exactly the five narrow plugin methods', () => {
    const client = createPluginPanelClient(transport().value)

    expect(Object.keys(client).sort()).toEqual([
      'call',
      'getContext',
      'getState',
      'onContext',
      'setState'
    ])
  })

  it('calls host methods with the current context and surfaces coded failures', async () => {
    const fake = transport((command) => {
      if (command.type === 'context:get') return { type: 'context', context: CONTEXT }
      if (command.type === 'api:call' && command.method === 'fs.readText')
        return { type: 'api:result', context: CONTEXT, ok: true, value: { text: 'hi' } }
      return {
        type: 'api:result',
        context: CONTEXT,
        ok: false,
        code: 'PERMISSION_DENIED',
        message: '需要权限 git.write'
      }
    })
    const client = createPluginPanelClient(fake.value)
    await expect(client.call('fs.readText', { path: 'a.ts' })).resolves.toEqual({ text: 'hi' })
    expect(fake.invoke).toHaveBeenLastCalledWith({
      type: 'api:call',
      context: CONTEXT,
      method: 'fs.readText',
      params: { path: 'a.ts' }
    })
    await expect(client.call('git.commit', { message: 'x' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: '需要权限 git.write'
    })
  })

  it('validates context/state results and sends only shared panel commands', async () => {
    const fake = transport()
    const client = createPluginPanelClient(fake.value)

    await expect(client.getContext()).resolves.toEqual(CONTEXT)
    await expect(client.getState(CONTEXT.generation)).resolves.toEqual({ selected: 2 })
    await expect(client.setState(CONTEXT.generation, { selected: 3 })).resolves.toBeUndefined()

    expect(fake.invoke.mock.calls).toEqual([
      [{ type: 'context:get' }],
      [{ type: 'state:get', context: CONTEXT }],
      [{ type: 'state:set', context: CONTEXT, value: { selected: 3 } }]
    ])
  })

  it('rejects generation mismatches locally without invoking Main', async () => {
    const fake = transport()
    const client = createPluginPanelClient(fake.value)
    await client.getContext()
    fake.invoke.mockClear()

    await expect(client.getState(CONTEXT.generation - 1)).rejects.toThrow('generation is stale')
    await expect(client.setState(CONTEXT.generation + 1, null)).rejects.toThrow(
      'generation is stale'
    )
    expect(fake.invoke).not.toHaveBeenCalled()
  })

  it('rejects invalid JSON state locally without invoking Main', async () => {
    const fake = transport()
    const client = createPluginPanelClient(fake.value)
    await client.getContext()
    fake.invoke.mockClear()

    await expect(client.setState(CONTEXT.generation, { invalid: Number.NaN })).rejects.toThrow(
      'invalid'
    )
    expect(fake.invoke).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed context', { type: 'context', context: { ...CONTEXT, generation: -1 } }],
    ['wrong result kind', { type: 'state:stored', context: CONTEXT }],
    ['malformed state', { type: 'state', context: CONTEXT, value: { bad: undefined } }]
  ])('rejects a %s result from Main', async (_label, result) => {
    const fake = transport((command) =>
      command.type === 'context:get' ? { type: 'context', context: CONTEXT } : result
    )
    const client = createPluginPanelClient(fake.value)

    if (_label === 'malformed context') {
      await expect(
        createPluginPanelClient(transport(() => result).value).getContext()
      ).rejects.toThrow('invalid')
      return
    }
    await client.getContext()
    await expect(client.getState(CONTEXT.generation)).rejects.toThrow('invalid')
  })

  it('validates context events, updates the cache, and removes the exact subscription', async () => {
    const fake = transport()
    const client = createPluginPanelClient(fake.value)
    await client.getContext()
    const listener = vi.fn()
    const unsubscribe = client.onContext(listener)

    fake.emit({ ...CONTEXT, generation: -1 })
    expect(listener).not.toHaveBeenCalled()
    fake.emit({ ...CONTEXT, sessionId: 'session-2', generation: 8 })
    expect(listener).toHaveBeenCalledWith({ ...CONTEXT, sessionId: 'session-2', generation: 8 })
    expect(fake.listenerCount()).toBe(1)

    unsubscribe()
    expect(fake.listenerCount()).toBe(0)
    fake.emit({ ...CONTEXT, sessionId: 'session-3', generation: 9 })
    expect(listener).toHaveBeenCalledTimes(1)

    fake.invoke.mockClear()
    await expect(client.getState(8)).resolves.toEqual({ selected: 2 })
    expect(fake.invoke).toHaveBeenCalledTimes(1)
  })

  it('rejects a response for a different context without rolling the cache backward', async () => {
    const fake = transport((command) => {
      if (command.type === 'context:get') return { type: 'context', context: CONTEXT }
      return {
        type: 'state',
        context: { ...CONTEXT, sessionId: 'old-session', generation: 6 },
        value: null
      }
    })
    const client = createPluginPanelClient(fake.value)
    await client.getContext()

    await expect(client.getState(CONTEXT.generation)).rejects.toThrow('context is stale')
    fake.invoke.mockClear()
    await expect(client.getState(CONTEXT.generation)).rejects.toThrow('context is stale')
    expect(fake.invoke).toHaveBeenCalledTimes(1)
  })

  it('offers manifest.json views the pluginBridge shape over the same client', async () => {
    const fake = transport((command) => {
      if (command.type === 'context:get') return { type: 'context', context: CONTEXT }
      return { type: 'api:result', context: CONTEXT, ok: true, value: { ok: 1 } }
    })
    const bridge = createPiDesktopPluginBridge(createPluginPanelClient(fake.value))
    expect(Object.keys(bridge).sort()).toEqual(['invoke', 'on'])
    await expect(bridge.invoke('ui.showToast', { message: 'hi' })).resolves.toEqual({ ok: 1 })
    expect(fake.invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: 'ui.showToast', params: { message: 'hi' } })
    )
    await bridge.invoke('workspace.get')
    expect(fake.invoke).toHaveBeenLastCalledWith(expect.objectContaining({ params: {} }))

    const seen: unknown[] = []
    const off = bridge.on('workspace:changed', (payload) => seen.push(payload))
    bridge.on('appearance:changed', () => seen.push('never'))()
    fake.emit({ ...CONTEXT, projectPath: '/workspace/other', generation: 8 })
    off()
    expect(seen).toEqual([{ path: '/workspace/other' }])
  })
})
