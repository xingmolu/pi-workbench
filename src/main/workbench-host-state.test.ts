import { describe, expect, it } from 'vitest'
import type { PiPackageRoot } from '../shared/workbench-host-contracts'
import { workbenchSnapshotSchema } from '../shared/workbench-schemas'
import type { WorkbenchManifestDiscovery } from './workbench-manifest'
import {
  createWorkbenchHostState,
  type WorkbenchHostState,
  type WorkbenchPanelView,
  type WorkbenchPanelViewRequest
} from './workbench-host-state'

class FakePanelView implements WorkbenchPanelView {
  visible = false
  destroyed = false
  contexts: WorkbenchPanelViewRequest['context'][] = []

  setBounds(): void {
    // Bounds are irrelevant to the pure lifecycle assertions.
  }
  setVisible(visible: boolean): void {
    this.visible = visible
  }
  setContext(context: WorkbenchPanelViewRequest['context']): void {
    this.contexts.push(context)
  }
  destroy(): void {
    this.destroyed = true
  }
}

function externalPlugin(): WorkbenchManifestDiscovery['plugins'][number] {
  return {
    pluginId: 'acme.notes',
    name: 'Acme Notes',
    version: '1.0.0',
    source: 'desktop-plugin:acme.notes',
    scope: 'user',
    requestedPermissions: [],
    hasExecutablePiResources: false,
    canonicalRootPath: '/plugins/acme.notes',
    manifestPath: '/plugins/acme.notes/pi-desktop.json',
    workbench: [
      {
        contribution: {
          pluginId: 'acme.notes',
          viewId: 'acme.notes.panel',
          title: 'Notes',
          icon: 'plugin',
          activation: 'onApp',
          surface: { kind: 'sandboxed-web' }
        },
        canonicalEntryPath: '/plugins/acme.notes/index.html'
      },
      {
        contribution: {
          pluginId: 'acme.notes',
          viewId: 'acme.notes.project-panel',
          title: 'Project Notes',
          icon: 'plugin',
          activation: 'onProject',
          surface: { kind: 'sandboxed-web' }
        },
        canonicalEntryPath: '/plugins/acme.notes/project.html'
      }
    ]
  }
}

function createHarness(
  discoveries: WorkbenchManifestDiscovery[],
  persisted = new Map<string, unknown>(),
  createPanelView?: (request: WorkbenchPanelViewRequest) => Promise<FakePanelView>
): {
  state: WorkbenchHostState
  rootsSeen: PiPackageRoot[][]
  views: Array<{ request: WorkbenchPanelViewRequest; view: FakePanelView }>
  persisted: Map<string, unknown>
  browserCalls: Array<{
    visible: boolean
    bounds?: { x: number; y: number; width: number; height: number }
  }>
} {
  const rootsSeen: PiPackageRoot[][] = []
  const views: Array<{ request: WorkbenchPanelViewRequest; view: FakePanelView }> = []
  const browserCalls: Array<{
    visible: boolean
    bounds?: { x: number; y: number; width: number; height: number }
  }> = []
  const state = createWorkbenchHostState({
    appVersion: '0.1.0',
    userRoots: async () => [],
    discover: async ({ roots }) => {
      rootsSeen.push([...roots])
      return discoveries.shift() ?? { plugins: [], diagnostics: [] }
    },
    store: {
      get: (key) => persisted.get(key),
      set: (key, value) => persisted.set(key, value)
    },
    createView: async (request) => {
      const view = createPanelView ? await createPanelView(request) : new FakePanelView()
      views.push({ request, view })
      return view
    },
    nativeViews: {
      browser: {
        setView: (visible, bounds) => {
          browserCalls.push(bounds ? { visible, bounds } : { visible })
        }
      }
    }
  })
  return { state, rootsSeen, views, persisted, browserCalls }
}

describe('Workbench host state', () => {
  it('merges one locked built-in registry with discovered onApp contributions', async () => {
    const { state } = createHarness([{ plugins: [externalPlugin()], diagnostics: [] }])

    await state.reload()

    expect(state.snapshot().plugins).toEqual([
      expect.objectContaining({
        pluginId: 'works.pi.desktop.builtin',
        builtin: true,
        desktopEnabled: true
      }),
      expect.objectContaining({ pluginId: 'acme.notes', builtin: false, desktopEnabled: true })
    ])
    expect(state.snapshot().contributions.map(({ viewId }) => viewId)).toEqual([
      'works.pi.desktop.browser',
      'acme.notes.panel'
    ])
    expect(workbenchSnapshotSchema.parse(state.snapshot())).toEqual(state.snapshot())
  })

  it('keeps built-in plugin and view ids reserved in the merged registry', async () => {
    const reservedPlugin = externalPlugin()
    reservedPlugin.pluginId = 'works.pi.desktop.builtin'
    reservedPlugin.workbench = reservedPlugin.workbench.map((entry) => ({
      ...entry,
      contribution: { ...entry.contribution, pluginId: 'works.pi.desktop.builtin' }
    }))
    const reservedView = externalPlugin()
    reservedView.pluginId = 'acme.reserved-view'
    reservedView.workbench = [
      {
        ...reservedView.workbench[0],
        contribution: {
          ...reservedView.workbench[0].contribution,
          pluginId: 'acme.reserved-view',
          viewId: 'works.pi.desktop.browser'
        }
      }
    ]
    const { state } = createHarness([{ plugins: [reservedPlugin, reservedView], diagnostics: [] }])

    await state.reload()

    expect(state.snapshot().plugins.map(({ pluginId }) => pluginId)).toEqual([
      'works.pi.desktop.builtin'
    ])
    expect(state.snapshot().diagnostics.map(({ code }) => code)).toEqual([
      'reserved-plugin-id',
      'reserved-view-id'
    ])
    expect(workbenchSnapshotSchema.safeParse(state.snapshot()).success).toBe(true)
  })

  it('publishes project contributions only in a monotonically advancing context', async () => {
    const { state } = createHarness([{ plugins: [externalPlugin()], diagnostics: [] }])
    await state.reload()

    state.setContext({ projectPath: '/projects/one', sessionId: 'session-1', generation: 1 })

    expect(state.snapshot().contributions.map(({ viewId }) => viewId)).toEqual([
      'works.pi.desktop.files',
      'works.pi.desktop.review',
      'works.pi.desktop.terminal',
      'works.pi.desktop.browser',
      'acme.notes.panel',
      'acme.notes.project-panel'
    ])
    expect(state.panelContext('acme.notes.project-panel')).toEqual({
      pluginId: 'acme.notes',
      viewId: 'acme.notes.project-panel',
      projectPath: '/projects/one',
      sessionId: 'session-1',
      generation: 1
    })
    expect(() => state.setContext({ projectPath: null, sessionId: null, generation: 0 })).toThrow(
      /generation/i
    )
    expect(() =>
      state.setContext({ projectPath: '/projects/two', sessionId: 'session-2', generation: 1 })
    ).toThrow(/generation/i)
  })

  it('replaces the complete package-root collection before rediscovery', async () => {
    const replacement = externalPlugin()
    replacement.pluginId = 'acme.tasks'
    replacement.name = 'Acme Tasks'
    replacement.workbench = replacement.workbench.map((entry, index) => ({
      ...entry,
      contribution: {
        ...entry.contribution,
        pluginId: 'acme.tasks',
        viewId: index === 0 ? 'acme.tasks.panel' : 'acme.tasks.project-panel'
      }
    }))
    const { state, rootsSeen } = createHarness([
      { plugins: [externalPlugin()], diagnostics: [] },
      { plugins: [replacement], diagnostics: [] }
    ])
    const first = {
      path: '/packages/notes',
      source: 'pi-package:notes',
      scope: 'user',
      hasExecutablePiResources: true
    } as const
    const second = {
      path: '/packages/tasks',
      source: 'pi-package:tasks',
      scope: 'project',
      hasExecutablePiResources: false
    } as const

    await state.setPackageRoots([first])
    await state.setPackageRoots([second])

    expect(rootsSeen).toEqual([[first], [second]])
    expect(state.snapshot().plugins.map(({ pluginId }) => pluginId)).toEqual([
      'works.pi.desktop.builtin',
      'acme.tasks'
    ])
  })

  it('persists external desktop enablement and disposes its visible panel only', async () => {
    const persisted = new Map<string, unknown>()
    const first = createHarness([{ plugins: [externalPlugin()], diagnostics: [] }], persisted)
    await first.state.reload()

    await first.state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true,
      bounds: { x: 5, y: 10, width: 400, height: 300 }
    })
    await first.state.dispatch({
      type: 'plugin:set-enabled',
      pluginId: 'acme.notes',
      desktopEnabled: false
    })

    expect(first.views).toHaveLength(1)
    expect(first.views[0].view.destroyed).toBe(true)
    expect(first.state.snapshot().contributions.map(({ pluginId }) => pluginId)).not.toContain(
      'acme.notes'
    )
    expect(first.state.snapshot().plugins[1]).toMatchObject({
      desktopEnabled: false,
      hasExecutablePiResources: false
    })
    expect(() => first.state.panelContext('acme.notes.panel')).toThrow(/unavailable/i)
    await expect(
      first.state.dispatch({
        type: 'plugin:set-enabled',
        pluginId: 'works.pi.desktop.builtin',
        desktopEnabled: false
      })
    ).rejects.toThrow(/built-in/i)

    const restarted = createHarness([{ plugins: [externalPlugin()], diagnostics: [] }], persisted)
    await restarted.state.reload()
    expect(restarted.state.snapshot().plugins[1].desktopEnabled).toBe(false)
  })

  it('validates and persists panel state by plugin, view, and stable project bucket', async () => {
    const persisted = new Map<string, unknown>()
    const { state } = createHarness([{ plugins: [externalPlugin()], diagnostics: [] }], persisted)
    await state.reload()
    state.setContext({ projectPath: '/projects/one', sessionId: 'session-1', generation: 1 })
    const projectOne = state.panelContext('acme.notes.panel')

    state.setPanelState(projectOne, { draft: 'one' })
    state.setContext({ projectPath: '/projects/two', sessionId: 'session-2', generation: 2 })
    expect(state.getPanelState(state.panelContext('acme.notes.panel'))).toBeNull()
    state.setPanelState(state.panelContext('acme.notes.panel'), { draft: 'two' })
    state.setContext({ projectPath: null, sessionId: null, generation: 3 })
    const appContext = state.panelContext('acme.notes.panel')
    state.setPanelState(appContext, { app: true })
    state.setContext({ projectPath: '/projects/one', sessionId: 'session-3', generation: 4 })

    expect(state.getPanelState(state.panelContext('acme.notes.panel'))).toEqual({ draft: 'one' })
    expect(() => state.getPanelState(projectOne)).toThrow(/generation|context/i)
    expect(() =>
      state.setPanelState(state.panelContext('acme.notes.panel'), 'x'.repeat(32 * 1024))
    ).toThrow()

    state.setContext({ projectPath: null, sessionId: null, generation: 5 })
    expect(state.getPanelState(state.panelContext('acme.notes.panel'))).toEqual({ app: true })
  })

  it('updates onApp views, disposes project views, and rejects late generation operations', async () => {
    const plugin = externalPlugin()
    plugin.scope = 'project'
    const { state, views } = createHarness([{ plugins: [plugin], diagnostics: [] }])
    await state.reload()
    state.setContext({ projectPath: '/projects/one', sessionId: 'session-1', generation: 1 })
    await state.dispatch({ type: 'view:set', viewId: 'acme.notes.panel', visible: true })
    await state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.project-panel',
      visible: true
    })
    const oldContext = state.panelContext('acme.notes.panel')
    let operationSignal: AbortSignal | undefined
    let releaseOperation: (() => void) | undefined
    const operation = state.runPanelOperation(oldContext, async (signal) => {
      operationSignal = signal
      await new Promise<void>((resolve) => {
        releaseOperation = resolve
      })
      return 'late result'
    })

    state.setContext({ projectPath: '/projects/two', sessionId: 'session-2', generation: 2 })
    releaseOperation?.()

    expect(operationSignal?.aborted).toBe(true)
    await expect(operation).rejects.toThrow(/generation|context|abort/i)
    expect(views[0].view.destroyed).toBe(false)
    expect(views[0].view.contexts.at(-1)).toEqual({
      pluginId: 'acme.notes',
      viewId: 'acme.notes.panel',
      projectPath: '/projects/two',
      sessionId: 'session-2',
      generation: 2
    })
    expect(views[1].view.destroyed).toBe(true)
    expect(() => state.getPanelState(oldContext)).toThrow(/generation|context/i)
  })

  it('aborts and destroys a view created after its reveal generation became stale', async () => {
    const lateView = new FakePanelView()
    let releaseView: (() => void) | undefined
    let createSignal: AbortSignal | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const { state } = createHarness(
      [{ plugins: [externalPlugin()], diagnostics: [] }],
      new Map(),
      async (request) => {
        createSignal = request.signal
        markStarted?.()
        await new Promise<void>((resolve) => {
          releaseView = resolve
        })
        return lateView
      }
    )
    await state.reload()
    state.setContext({ projectPath: '/projects/one', sessionId: 'session-1', generation: 1 })

    const reveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    await started
    state.setContext({ projectPath: '/projects/two', sessionId: 'session-2', generation: 2 })
    releaseView?.()

    expect(createSignal?.aborted).toBe(true)
    await expect(reveal).rejects.toThrow(/generation|context|abort/i)
    expect(lateView.destroyed).toBe(true)
  })

  it('keeps only the selected host-owned panel visible across native and sandboxed views', async () => {
    const { state, views, browserCalls } = createHarness([
      { plugins: [externalPlugin()], diagnostics: [] }
    ])
    await state.reload()
    state.setContext({ projectPath: '/projects/one', sessionId: 'session-1', generation: 1 })
    const bounds = { x: 10, y: 20, width: 500, height: 400 }

    await state.dispatch({
      type: 'view:set',
      viewId: 'works.pi.desktop.browser',
      visible: true,
      bounds
    })
    await state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true,
      bounds
    })
    await state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.project-panel',
      visible: true,
      bounds
    })
    await state.dispatch({
      type: 'view:set',
      viewId: 'works.pi.desktop.browser',
      visible: false
    })
    await state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true,
      bounds
    })

    expect(browserCalls).toEqual([
      { visible: true, bounds },
      { visible: false },
      { visible: false }
    ])
    expect(views[0].view.visible).toBe(true)
    expect(views[1].view.visible).toBe(false)
    state.setContext({ projectPath: '/projects/two', sessionId: 'session-2', generation: 2 })
    expect(views[1].view.destroyed).toBe(true)
  })

  it('recreates after two crashes and desktop-disables an external plugin on its third crash', async () => {
    const persisted = new Map<string, unknown>()
    const plugin = externalPlugin()
    plugin.hasExecutablePiResources = true
    const { state, views } = createHarness([{ plugins: [plugin], diagnostics: [] }], persisted)
    await state.reload()

    for (let crash = 0; crash < 3; crash += 1) {
      await state.dispatch({ type: 'view:set', viewId: 'acme.notes.panel', visible: true })
      views[crash].request.onCrash(`crash-${crash + 1}`)
      expect(views[crash].view.destroyed).toBe(true)
    }

    expect(views).toHaveLength(3)
    expect(state.snapshot().plugins[1]).toMatchObject({
      desktopEnabled: false,
      hasExecutablePiResources: true,
      diagnostics: [expect.objectContaining({ code: 'plugin-crash-disabled' })]
    })
    expect(state.snapshot().diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'plugin-crash-disabled',
        pluginId: 'acme.notes'
      })
    )
    expect(state.snapshot().contributions.map(({ pluginId }) => pluginId)).not.toContain(
      'acme.notes'
    )
  })
})
