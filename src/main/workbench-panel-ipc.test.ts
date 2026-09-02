import { describe, expect, it, vi } from 'vitest'
import type { JsonValue, PluginPanelContext } from '../shared/workbench-contracts'
import type { WorkbenchHost, WorkbenchPanelStateAdapter } from './workbench-host'
import { createWorkbenchPanelIpcRouter, type WorkbenchPanelIpcSender } from './workbench-panel-ipc'

class FakeSender implements WorkbenchPanelIpcSender {
  readonly mainFrame = {}
  private readonly destroyedListeners = new Set<() => void>()

  once(event: 'destroyed', listener: () => void): this {
    expect(event).toBe('destroyed')
    this.destroyedListeners.add(listener)
    return this
  }

  removeListener(event: 'destroyed', listener: () => void): this {
    expect(event).toBe('destroyed')
    this.destroyedListeners.delete(listener)
    return this
  }

  destroy(): void {
    for (const listener of [...this.destroyedListeners]) listener()
    this.destroyedListeners.clear()
  }
}

const NOTES_CONTEXT: PluginPanelContext = {
  pluginId: 'acme.notes',
  viewId: 'acme.notes.panel',
  projectPath: '/workspace/project',
  sessionId: 'session-1',
  generation: 7
}

function fakeAdapter(initialContext = NOTES_CONTEXT): {
  adapter: WorkbenchPanelStateAdapter
  setContext: (context: PluginPanelContext) => void
  getState: ReturnType<typeof vi.fn>
  setState: ReturnType<typeof vi.fn>
} {
  let context = initialContext
  const getState = vi.fn((): JsonValue => ({ selected: 2 }))
  const setState = vi.fn()
  return {
    adapter: {
      context: () => context,
      getState,
      setState,
      runOperation: async (_context, operation) => operation(new AbortController().signal)
    },
    setContext: (value) => {
      context = value
    },
    getState,
    setState
  }
}

function setup(): {
  sender: FakeSender
  host: WorkbenchHost
  fake: ReturnType<typeof fakeAdapter>
  router: ReturnType<typeof createWorkbenchPanelIpcRouter>
} {
  const sender = new FakeSender()
  const host = {} as WorkbenchHost
  const fake = fakeAdapter()
  const router = createWorkbenchPanelIpcRouter({
    createAdapter: vi.fn(() => fake.adapter)
  })
  router.bind(sender, host, NOTES_CONTEXT.viewId)
  return { sender, host, fake, router }
}

describe('Workbench panel sender-scoped IPC', () => {
  it('routes context and state commands through the sender binding', async () => {
    const { sender, fake, router } = setup()

    await expect(
      router.handle({ sender, senderFrame: sender.mainFrame }, { type: 'context:get' })
    ).resolves.toEqual({ type: 'context', context: NOTES_CONTEXT })
    await expect(
      router.handle(
        { sender, senderFrame: sender.mainFrame },
        { type: 'state:get', context: NOTES_CONTEXT }
      )
    ).resolves.toEqual({
      type: 'state',
      context: NOTES_CONTEXT,
      value: { selected: 2 }
    })
    await expect(
      router.handle(
        { sender, senderFrame: sender.mainFrame },
        { type: 'state:set', context: NOTES_CONTEXT, value: { selected: 3 } }
      )
    ).resolves.toEqual({ type: 'state:stored', context: NOTES_CONTEXT })

    expect(fake.getState).toHaveBeenCalledWith(NOTES_CONTEXT)
    expect(fake.setState).toHaveBeenCalledWith(NOTES_CONTEXT, { selected: 3 })
  })

  it.each([
    ['another view', { ...NOTES_CONTEXT, viewId: 'acme.calendar.panel' }],
    ['another plugin', { ...NOTES_CONTEXT, pluginId: 'other.plugin' }],
    ['a stale generation', { ...NOTES_CONTEXT, generation: NOTES_CONTEXT.generation - 1 }]
  ])('rejects a command targeting %s', async (_label, context) => {
    const { sender, fake, router } = setup()

    await expect(
      router.handle({ sender, senderFrame: sender.mainFrame }, { type: 'state:get', context })
    ).rejects.toThrow('context is stale')
    expect(fake.getState).not.toHaveBeenCalled()
  })

  it('revalidates the authoritative adapter context after a generation change', async () => {
    const { sender, fake, router } = setup()
    fake.setContext({ ...NOTES_CONTEXT, sessionId: 'session-2', generation: 8 })

    await expect(
      router.handle(
        { sender, senderFrame: sender.mainFrame },
        { type: 'state:set', context: NOTES_CONTEXT, value: null }
      )
    ).rejects.toThrow('context is stale')
    expect(fake.setState).not.toHaveBeenCalled()
  })

  it('rejects unbound senders and non-main-frame commands', async () => {
    const { sender, router } = setup()
    const unbound = new FakeSender()

    await expect(
      router.handle({ sender: unbound, senderFrame: unbound.mainFrame }, { type: 'context:get' })
    ).rejects.toThrow('sender is not bound')
    await expect(
      router.handle({ sender, senderFrame: {} }, { type: 'context:get' })
    ).rejects.toThrow('main frame')
  })

  it('removes a sender binding on WebContents destruction', async () => {
    const { sender, router } = setup()
    sender.destroy()

    await expect(
      router.handle({ sender, senderFrame: sender.mainFrame }, { type: 'context:get' })
    ).rejects.toThrow('sender is not bound')
  })

  it('removes every sender owned by a disposed host', async () => {
    const { sender, host, router } = setup()
    router.unbindHost(host)

    await expect(
      router.handle({ sender, senderFrame: sender.mainFrame }, { type: 'context:get' })
    ).rejects.toThrow('sender is not bound')
  })

  it('uses compare-on-unbind so an old cleanup cannot remove a newer binding', async () => {
    const sender = new FakeSender()
    const host = {} as WorkbenchHost
    const original = fakeAdapter()
    const replacement = fakeAdapter({
      ...NOTES_CONTEXT,
      pluginId: 'acme.replacement',
      viewId: 'acme.replacement.panel'
    })
    const replacementHost = {} as WorkbenchHost
    const router = createWorkbenchPanelIpcRouter({
      createAdapter: (candidateHost) =>
        candidateHost === replacementHost ? replacement.adapter : original.adapter
    })
    const oldCleanup = router.bind(sender, host, NOTES_CONTEXT.viewId)
    router.bind(sender, replacementHost, 'acme.replacement.panel')

    oldCleanup()

    await expect(
      router.handle({ sender, senderFrame: sender.mainFrame }, { type: 'context:get' })
    ).resolves.toEqual({ type: 'context', context: replacement.adapter.context() })
  })

  it('rejects malformed commands before reaching the adapter', async () => {
    const { sender, fake, router } = setup()

    await expect(
      router.handle(
        { sender, senderFrame: sender.mainFrame },
        { type: 'state:set', context: NOTES_CONTEXT, value: undefined }
      )
    ).rejects.toThrow('invalid')
    expect(fake.setState).not.toHaveBeenCalled()
  })
})
