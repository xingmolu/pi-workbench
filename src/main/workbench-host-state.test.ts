import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchBounds } from '../shared/contracts'
import type { PiPackageRoot } from '../shared/workbench-host-contracts'
import { workbenchSnapshotSchema } from '../shared/workbench-schemas'
import type { WorkbenchManifestDiscovery } from './workbench-manifest'
import { createPiPackageRootsLifecycle } from './workbench-package-roots'
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
  bounds: WorkbenchBounds[] = []

  constructor(private readonly onDestroy?: () => void) {}

  setBounds(bounds: WorkbenchBounds): void {
    this.bounds.push(bounds)
  }
  setVisible(visible: boolean): void {
    this.visible = visible
  }
  setContext(context: WorkbenchPanelViewRequest['context']): void {
    this.contexts.push(context)
  }
  destroy(): void {
    this.destroyed = true
    this.onDestroy?.()
  }
}

type Deferred<Value> = {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (error: Error) => void
}

function createDeferred<Value>(): Deferred<Value> {
  let resolvePromise!: (value: Value) => void
  let rejectPromise!: (error: Error) => void
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

type ControlledViewAttempt = {
  request: WorkbenchPanelViewRequest
  view: FakePanelView
  resolve: () => void
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

function externalPluginAt(
  canonicalRootPath: string,
  version: string
): WorkbenchManifestDiscovery['plugins'][number] {
  const plugin = externalPlugin()
  plugin.version = version
  plugin.canonicalRootPath = canonicalRootPath
  plugin.manifestPath = `${canonicalRootPath}/pi-desktop.json`
  plugin.workbench = plugin.workbench.map((entry) => ({
    ...entry,
    canonicalEntryPath: entry.canonicalEntryPath.replace('/plugins/acme.notes', canonicalRootPath)
  }))
  return plugin
}

function secondExternalPlugin(): WorkbenchManifestDiscovery['plugins'][number] {
  const plugin = externalPlugin()
  plugin.pluginId = 'acme.tasks'
  plugin.name = 'Acme Tasks'
  plugin.canonicalRootPath = '/plugins/acme.tasks'
  plugin.manifestPath = '/plugins/acme.tasks/pi-desktop.json'
  plugin.workbench = plugin.workbench.map((entry, index) => ({
    ...entry,
    contribution: {
      ...entry.contribution,
      pluginId: 'acme.tasks',
      viewId: index === 0 ? 'acme.tasks.panel' : 'acme.tasks.board',
      activation: 'onApp'
    },
    canonicalEntryPath:
      index === 0 ? '/plugins/acme.tasks/index.html' : '/plugins/acme.tasks/board.html'
  }))
  return plugin
}

function createHarness(
  discoveries: Array<WorkbenchManifestDiscovery | Promise<WorkbenchManifestDiscovery>>,
  persisted = new Map<string, unknown>(),
  createPanelView?: (request: WorkbenchPanelViewRequest) => Promise<FakePanelView>,
  setBrowserView?: (
    visible: boolean,
    bounds?: { x: number; y: number; width: number; height: number }
  ) => void | Promise<void>,
  onState?: (snapshot: ReturnType<WorkbenchHostState['snapshot']>) => void,
  canonicalizeRoot?: (path: string) => Promise<string>
): {
  state: WorkbenchHostState
  rootsSeen: PiPackageRoot[][]
  views: Array<{ request: WorkbenchPanelViewRequest; view: FakePanelView }>
  persisted: Map<string, unknown>
  browserCalls: Array<{
    visible: boolean
    bounds?: { x: number; y: number; width: number; height: number }
  }>
  stateChanges: ReturnType<WorkbenchHostState['snapshot']>[]
} {
  const rootsSeen: PiPackageRoot[][] = []
  const views: Array<{ request: WorkbenchPanelViewRequest; view: FakePanelView }> = []
  const browserCalls: Array<{
    visible: boolean
    bounds?: { x: number; y: number; width: number; height: number }
  }> = []
  const stateChanges: ReturnType<WorkbenchHostState['snapshot']>[] = []
  const state = createWorkbenchHostState({
    appVersion: '0.1.0',
    userRoots: async () => [],
    canonicalizeRoot: canonicalizeRoot ?? (async (path) => path),
    discover: async ({ roots }) => {
      rootsSeen.push([...roots])
      return (await discoveries.shift()) ?? { plugins: [], diagnostics: [] }
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
          return setBrowserView?.(visible, bounds)
        }
      }
    },
    onState: (snapshot) => {
      stateChanges.push(snapshot)
      onState?.(snapshot)
    }
  })
  return { state, rootsSeen, views, persisted, browserCalls, stateChanges }
}

function createControlledViewHarness(
  discoveries: Array<WorkbenchManifestDiscovery | Promise<WorkbenchManifestDiscovery>>
): ReturnType<typeof createHarness> & {
  starts: Deferred<ControlledViewAttempt>[]
  attemptCount: () => number
} {
  const starts = [createDeferred<ControlledViewAttempt>(), createDeferred<ControlledViewAttempt>()]
  let attemptCount = 0
  const harness = createHarness(discoveries, new Map(), async (request) => {
    const start = starts[attemptCount]
    attemptCount += 1
    const view = new FakePanelView()
    const completion = createDeferred<FakePanelView>()
    start.resolve({ request, view, resolve: () => completion.resolve(view) })
    return completion.promise
  })
  return { ...harness, starts, attemptCount: () => attemptCount }
}

describe('Workbench host state', () => {
  it('treats hiding a removed or disabled panel as idempotent without changing the active browser', async () => {
    const { state, browserCalls } = createHarness([
      { plugins: [externalPlugin()], diagnostics: [] }
    ])
    await state.reload()
    await state.dispatch({
      type: 'plugin:set-enabled',
      pluginId: 'acme.notes',
      desktopEnabled: false
    })
    await state.dispatch({ type: 'view:set', viewId: 'works.pi.desktop.browser', visible: true })
    const count = browserCalls.length
    for (const viewId of ['acme.notes.panel', 'removed.plugin.panel']) {
      await expect(
        state.dispatch({ type: 'view:set', viewId, visible: false })
      ).resolves.toBeDefined()
      await expect(state.dispatch({ type: 'view:set', viewId, visible: true })).rejects.toThrow(
        'unavailable'
      )
    }
    expect(browserCalls).toHaveLength(count)
  })
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
      source: 'Pi 用户包',
      scope: 'user',
      hasExecutablePiResources: true
    } as const
    const second = {
      path: '/packages/tasks',
      source: 'Pi 项目包',
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

  it('blocks old external registry entries while reload is in flight but keeps browser usable', async () => {
    const delayedDiscovery = createDeferred<WorkbenchManifestDiscovery>()
    const { state, rootsSeen, views, browserCalls } = createHarness([
      { plugins: [externalPlugin()], diagnostics: [] },
      delayedDiscovery.promise
    ])
    await state.reload()

    const reload = state.reload()
    await vi.waitFor(() => expect(rootsSeen).toHaveLength(2))
    expect(state.snapshot().plugins.map(({ pluginId }) => pluginId)).toEqual([
      'works.pi.desktop.builtin'
    ])

    await expect(
      state.dispatch({ type: 'view:set', viewId: 'acme.notes.panel', visible: true })
    ).rejects.toThrow(/unavailable|reload/i)
    await expect(
      state.dispatch({
        type: 'view:set',
        viewId: 'works.pi.desktop.browser',
        visible: true,
        bounds: { x: 1, y: 2, width: 300, height: 200 }
      })
    ).resolves.toBeDefined()

    expect(views).toHaveLength(0)
    expect(browserCalls.at(-1)).toEqual({
      visible: true,
      bounds: { x: 1, y: 2, width: 300, height: 200 }
    })

    delayedDiscovery.resolve({ plugins: [externalPlugin()], diagnostics: [] })
    await reload
  })

  it('ignores teardown callbacks from an external view destroyed at the reload barrier', async () => {
    const { state } = createHarness(
      [
        { plugins: [externalPlugin()], diagnostics: [] },
        { plugins: [externalPlugin()], diagnostics: [] }
      ],
      new Map(),
      async (request) => new FakePanelView(() => request.onCrash('intentional reload teardown'))
    )
    await state.reload()
    await state.dispatch({ type: 'view:set', viewId: 'acme.notes.panel', visible: true })

    await state.reload()

    expect(state.snapshot().diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'plugin-crashed' })
    )
  })

  it('makes the latest package-root request win when discoveries finish out of order', async () => {
    const staleDiscovery = createDeferred<WorkbenchManifestDiscovery>()
    const latestDiscovery = createDeferred<WorkbenchManifestDiscovery>()
    const { state, rootsSeen } = createHarness([staleDiscovery.promise, latestDiscovery.promise])
    const staleRoot = {
      path: '/packages/stale',
      source: 'Pi 用户包',
      scope: 'user',
      hasExecutablePiResources: false
    } as const
    const latestRoot = {
      path: '/packages/latest',
      source: 'Pi 项目包',
      scope: 'project',
      hasExecutablePiResources: true
    } as const

    const staleReload = state.setPackageRoots([staleRoot])
    await vi.waitFor(() => expect(rootsSeen).toHaveLength(1))
    const latestReload = state.setPackageRoots([latestRoot])
    await vi.waitFor(() => expect(rootsSeen).toHaveLength(2))

    latestDiscovery.resolve({
      plugins: [externalPluginAt('/plugins/latest', '2.0.0')],
      diagnostics: [
        { severity: 'warning', code: 'latest-discovery', message: 'latest registry result' }
      ]
    })
    await latestReload
    staleDiscovery.resolve({
      plugins: [externalPluginAt('/plugins/stale', '1.0.0')],
      diagnostics: [
        { severity: 'error', code: 'stale-discovery', message: 'stale registry result' }
      ]
    })
    await staleReload

    expect(rootsSeen).toEqual([[staleRoot], [latestRoot]])
    expect(state.snapshot().plugins[1]).toMatchObject({
      pluginId: 'acme.notes',
      version: '2.0.0'
    })
    expect(state.snapshot().diagnostics.map(({ code }) => code)).toEqual(['latest-discovery'])
  })

  it('drops stale roots while canonicalization is still in flight', async () => {
    const staleCanonical = createDeferred<string>()
    const latestCanonical = createDeferred<string>()
    const { state, rootsSeen } = createHarness(
      [{ plugins: [externalPluginAt('/plugins/latest', '2.0.0')], diagnostics: [] }],
      new Map(),
      undefined,
      undefined,
      undefined,
      (path) =>
        path === '/packages/stale-alias' ? staleCanonical.promise : latestCanonical.promise
    )
    const staleRoot = {
      path: '/packages/stale-alias',
      source: 'Pi 用户包',
      scope: 'user',
      hasExecutablePiResources: false
    } as const
    const latestRoot = {
      path: '/packages/latest-alias',
      source: 'Pi 项目包',
      scope: 'project',
      hasExecutablePiResources: true
    } as const

    const staleReload = state.setPackageRoots([staleRoot])
    const latestReload = state.setPackageRoots([latestRoot])
    latestCanonical.resolve('/canonical/latest')
    await latestReload
    staleCanonical.resolve('/canonical/stale')
    await staleReload

    expect(rootsSeen).toEqual([
      [
        {
          ...latestRoot,
          path: '/canonical/latest'
        }
      ]
    ])
    expect(state.snapshot().plugins[1]).toMatchObject({ version: '2.0.0' })
  })

  it('discards an older plain reload result that completes after the latest reload', async () => {
    const staleDiscovery = createDeferred<WorkbenchManifestDiscovery>()
    const latestDiscovery = createDeferred<WorkbenchManifestDiscovery>()
    const { state, rootsSeen } = createHarness([staleDiscovery.promise, latestDiscovery.promise])

    const staleReload = state.reload()
    await vi.waitFor(() => expect(rootsSeen).toHaveLength(1))
    const latestReload = state.reload()
    await vi.waitFor(() => expect(rootsSeen).toHaveLength(2))
    latestDiscovery.resolve({
      plugins: [externalPluginAt('/plugins/latest', '2.0.0')],
      diagnostics: [
        { severity: 'warning', code: 'latest-discovery', message: 'latest registry result' }
      ]
    })
    await latestReload
    staleDiscovery.resolve({
      plugins: [externalPluginAt('/plugins/stale', '1.0.0')],
      diagnostics: [
        { severity: 'error', code: 'stale-discovery', message: 'stale registry result' }
      ]
    })
    const staleResult = await staleReload

    expect(staleResult.plugins[1]).toMatchObject({ version: '2.0.0' })
    expect(state.snapshot().plugins[1]).toMatchObject({ version: '2.0.0' })
    expect(state.snapshot().diagnostics.map(({ code }) => code)).toEqual(['latest-discovery'])
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

  it('allows a manually disabled plugin to be re-enabled before any crash lockout', async () => {
    const { state } = createHarness([{ plugins: [externalPlugin()], diagnostics: [] }])
    await state.reload()

    await state.dispatch({
      type: 'plugin:set-enabled',
      pluginId: 'acme.notes',
      desktopEnabled: false
    })
    await state.dispatch({
      type: 'plugin:set-enabled',
      pluginId: 'acme.notes',
      desktopEnabled: true
    })

    expect(state.snapshot().plugins[1].desktopEnabled).toBe(true)
    expect(state.snapshot().contributions.map(({ pluginId }) => pluginId)).toContain('acme.notes')
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

  it('isolates panel state across plugins, views, two projects, and the app bucket', async () => {
    const notes = externalPlugin()
    notes.workbench[1].contribution.activation = 'onApp'
    const tasks = secondExternalPlugin()
    const { state } = createHarness([{ plugins: [notes, tasks], diagnostics: [] }])
    await state.reload()

    state.setContext({ projectPath: '/projects/a', sessionId: 'session-a', generation: 1 })
    state.setPanelState(state.panelContext('acme.notes.panel'), { bucket: 'notes-panel-a' })
    state.setPanelState(state.panelContext('acme.notes.project-panel'), {
      bucket: 'notes-second-view-a'
    })
    state.setPanelState(state.panelContext('acme.tasks.panel'), { bucket: 'tasks-panel-a' })

    state.setContext({ projectPath: '/projects/b', sessionId: 'session-b', generation: 2 })
    expect(state.getPanelState(state.panelContext('acme.notes.panel'))).toBeNull()
    expect(state.getPanelState(state.panelContext('acme.notes.project-panel'))).toBeNull()
    expect(state.getPanelState(state.panelContext('acme.tasks.panel'))).toBeNull()
    state.setPanelState(state.panelContext('acme.notes.panel'), { bucket: 'notes-panel-b' })
    state.setPanelState(state.panelContext('acme.notes.project-panel'), {
      bucket: 'notes-second-view-b'
    })
    state.setPanelState(state.panelContext('acme.tasks.panel'), { bucket: 'tasks-panel-b' })

    state.setContext({ projectPath: null, sessionId: null, generation: 3 })
    expect(state.getPanelState(state.panelContext('acme.notes.panel'))).toBeNull()
    expect(state.getPanelState(state.panelContext('acme.notes.project-panel'))).toBeNull()
    expect(state.getPanelState(state.panelContext('acme.tasks.panel'))).toBeNull()
    state.setPanelState(state.panelContext('acme.notes.panel'), { bucket: 'notes-panel-app' })
    state.setPanelState(state.panelContext('acme.notes.project-panel'), {
      bucket: 'notes-second-view-app'
    })
    state.setPanelState(state.panelContext('acme.tasks.panel'), { bucket: 'tasks-panel-app' })

    state.setContext({ projectPath: '/projects/a', sessionId: 'session-a2', generation: 4 })
    expect(state.getPanelState(state.panelContext('acme.notes.panel'))).toEqual({
      bucket: 'notes-panel-a'
    })
    expect(state.getPanelState(state.panelContext('acme.notes.project-panel'))).toEqual({
      bucket: 'notes-second-view-a'
    })
    expect(state.getPanelState(state.panelContext('acme.tasks.panel'))).toEqual({
      bucket: 'tasks-panel-a'
    })

    state.setContext({ projectPath: '/projects/b', sessionId: 'session-b2', generation: 5 })
    expect(state.getPanelState(state.panelContext('acme.notes.panel'))).toEqual({
      bucket: 'notes-panel-b'
    })
    expect(state.getPanelState(state.panelContext('acme.notes.project-panel'))).toEqual({
      bucket: 'notes-second-view-b'
    })
    expect(state.getPanelState(state.panelContext('acme.tasks.panel'))).toEqual({
      bucket: 'tasks-panel-b'
    })

    state.setContext({ projectPath: null, sessionId: null, generation: 6 })
    expect(state.getPanelState(state.panelContext('acme.notes.panel'))).toEqual({
      bucket: 'notes-panel-app'
    })
    expect(state.getPanelState(state.panelContext('acme.notes.project-panel'))).toEqual({
      bucket: 'notes-second-view-app'
    })
    expect(state.getPanelState(state.panelContext('acme.tasks.panel'))).toEqual({
      bucket: 'tasks-panel-app'
    })
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

  it('destroys package views before applying a new project context', async () => {
    const plugin = externalPlugin()
    plugin.scope = 'project'
    const { state, views } = createHarness([
      { plugins: [plugin], diagnostics: [] },
      { plugins: [], diagnostics: [] }
    ])
    await state.reload()
    state.setContext({ projectPath: '/projects/one', sessionId: 'session-1', generation: 1 })
    await state.dispatch({ type: 'view:set', viewId: 'acme.notes.panel', visible: true })
    const oldView = views[0].view
    const lifecycle = createPiPackageRootsLifecycle({
      initialIdentity: { sessionId: 'session-1', generation: 1 },
      warn: vi.fn()
    })
    lifecycle.hostStarted()
    lifecycle.attachHost(state)

    lifecycle.transitionIdentity({ sessionId: 'session-2', generation: 2 }, () => {
      state.setContext({
        projectPath: '/projects/two',
        sessionId: 'session-2',
        generation: 2
      })
    })

    expect(oldView.destroyed).toBe(true)
    expect(oldView.contexts).not.toContainEqual(
      expect.objectContaining({ projectPath: '/projects/two', generation: 2 })
    )
  })

  it('prevents package discovery started before Agent exit from repopulating the registry', async () => {
    const staleDiscovery = createDeferred<WorkbenchManifestDiscovery>()
    const { state, rootsSeen } = createHarness([
      staleDiscovery.promise,
      { plugins: [], diagnostics: [] }
    ])
    const lifecycle = createPiPackageRootsLifecycle({
      initialIdentity: { sessionId: 'session-1', generation: 1 },
      warn: vi.fn()
    })
    lifecycle.hostStarted()
    lifecycle.attachHost(state)

    lifecycle.handleMessage({
      type: 'desktop-plugin-roots',
      sessionId: 'session-1',
      generation: 1,
      roots: [
        {
          path: '/packages/acme.notes',
          source: 'package-discovery',
          scope: 'project',
          hasExecutablePiResources: true
        }
      ]
    })
    await vi.waitFor(() => expect(rootsSeen).toHaveLength(1))

    lifecycle.hostExited()
    await vi.waitFor(() => expect(rootsSeen).toHaveLength(2))
    staleDiscovery.resolve({ plugins: [externalPlugin()], diagnostics: [] })
    await Promise.resolve()
    await Promise.resolve()

    expect(state.snapshot().plugins).not.toContainEqual(
      expect.objectContaining({ pluginId: 'acme.notes' })
    )
    expect(state.snapshot().contributions).not.toContainEqual(
      expect.objectContaining({ viewId: 'acme.notes.panel' })
    )
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

  it('counts initial-load crashes once and disables the plugin after the third attempt', async () => {
    type Attempt = {
      request: WorkbenchPanelViewRequest
      view: FakePanelView
      resolve: () => void
      reject: (error: Error) => void
    }
    const starts = [createDeferred<Attempt>(), createDeferred<Attempt>(), createDeferred<Attempt>()]
    let attemptIndex = 0
    const plugin = externalPlugin()
    plugin.hasExecutablePiResources = true
    const { state } = createHarness(
      [{ plugins: [plugin], diagnostics: [] }],
      new Map(),
      async (request) => {
        const index = attemptIndex
        attemptIndex += 1
        const view = new FakePanelView()
        const result = createDeferred<FakePanelView>()
        starts[index].resolve({
          request,
          view,
          resolve: () => result.resolve(view),
          reject: result.reject
        })
        if (index === 0) {
          request.onCrash('sync-initial-crash')
          request.onCrash('duplicate-sync-crash')
          return view
        }
        return result.promise
      }
    )
    await state.reload()

    const firstReveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    const first = await starts[0].promise
    await expect(firstReveal).rejects.toThrow(/abort|crash/i)
    expect(first.view.destroyed).toBe(true)
    expect(state.snapshot().plugins[1].desktopEnabled).toBe(true)

    const secondReveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    const second = await starts[1].promise
    second.request.onCrash('async-initial-crash')
    second.request.onCrash('duplicate-async-crash')
    second.reject(new Error('renderer exited while loading'))
    await expect(secondReveal).rejects.toThrow()
    expect(state.snapshot().plugins[1].desktopEnabled).toBe(true)

    const thirdReveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    const third = await starts[2].promise
    third.request.onCrash('third-initial-crash')
    third.resolve()
    await expect(thirdReveal).rejects.toThrow(/abort|crash/i)

    expect(third.view.destroyed).toBe(true)
    expect(attemptIndex).toBe(3)
    expect(state.snapshot().plugins[1]).toMatchObject({
      desktopEnabled: false,
      hasExecutablePiResources: true,
      diagnostics: [expect.objectContaining({ code: 'plugin-crash-disabled' })]
    })
    expect(state.snapshot().contributions.map(({ pluginId }) => pluginId)).not.toContain(
      'acme.notes'
    )
  })

  it('makes a hide invalidate an unresolved reveal of the same external view', async () => {
    const { state, starts } = createControlledViewHarness([
      { plugins: [externalPlugin()], diagnostics: [] }
    ])
    await state.reload()

    const reveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    const pending = await starts[0].promise
    await state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: false
    })
    pending.resolve()

    await expect(reveal).rejects.toThrow(/abort|selection|stale/i)
    expect(pending.view.destroyed).toBe(true)
    expect(pending.view.visible).toBe(false)
  })

  it('coalesces repeated bounds into one pending creation and applies the latest bounds', async () => {
    const { state, starts, attemptCount } = createControlledViewHarness([
      { plugins: [externalPlugin()], diagnostics: [] }
    ])
    await state.reload()
    const firstBounds = { x: 10, y: 20, width: 300, height: 200 }
    const latestBounds = { x: 12, y: 22, width: 302, height: 202 }

    const reveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true,
      bounds: firstBounds
    })
    const pending = await starts[0].promise

    const repeated = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true,
      bounds: latestBounds
    })
    void repeated.catch(() => undefined)
    void reveal.catch(() => undefined)
    await Promise.resolve()
    await Promise.resolve()

    expect(attemptCount()).toBe(1)
    await expect(repeated).resolves.toBeDefined()
    expect(pending.request.signal.aborted).toBe(false)
    pending.resolve()
    await expect(reveal).resolves.toBeDefined()
    expect(pending.view.bounds).toEqual([latestBounds])
    expect(pending.view.visible).toBe(true)
  })

  it('keeps repeated visible browser bounds in the same selection epoch', async () => {
    const operations = [createDeferred<void>(), createDeferred<void>()]
    let operationIndex = 0
    const { state, browserCalls } = createHarness(
      [{ plugins: [], diagnostics: [] }],
      new Map(),
      undefined,
      () => operations[operationIndex++]?.promise
    )
    await state.reload()
    const firstBounds = { x: 10, y: 20, width: 300, height: 200 }
    const latestBounds = { x: 12, y: 22, width: 302, height: 202 }

    const first = state.dispatch({
      type: 'view:set',
      viewId: 'works.pi.desktop.browser',
      visible: true,
      bounds: firstBounds
    })
    const latest = state.dispatch({
      type: 'view:set',
      viewId: 'works.pi.desktop.browser',
      visible: true,
      bounds: latestBounds
    })

    operations[1]!.resolve()
    await expect(latest).resolves.toBeDefined()
    operations[0]!.resolve()
    await expect(first).resolves.toBeDefined()
    await Promise.resolve()
    await Promise.resolve()

    expect(browserCalls).toEqual([
      { visible: true, bounds: firstBounds },
      { visible: true, bounds: latestBounds }
    ])
  })

  it('keeps only the latest external selection when creates resolve in reverse order', async () => {
    const plugin = externalPlugin()
    plugin.workbench[1].contribution.activation = 'onApp'
    const { state, starts } = createControlledViewHarness([{ plugins: [plugin], diagnostics: [] }])
    await state.reload()

    const revealA = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    const pendingA = await starts[0].promise
    const revealB = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.project-panel',
      visible: true
    })
    const pendingB = await starts[1].promise

    pendingB.resolve()
    await revealB
    pendingA.resolve()
    await expect(revealA).rejects.toThrow(/abort|selection|stale/i)

    expect(pendingA.view.destroyed).toBe(true)
    expect(pendingA.view.visible).toBe(false)
    expect(pendingB.view.destroyed).toBe(false)
    expect(pendingB.view.visible).toBe(true)
  })

  it('does not let a never-settling browser show block the latest external reveal', async () => {
    type NativeOperation = { visible: boolean; resolve: () => void; reject: () => void }
    const nativeStarts = [createDeferred<NativeOperation>(), createDeferred<NativeOperation>()]
    let browserVisible = false
    let nativeCallCount = 0
    const { state, views } = createHarness(
      [{ plugins: [externalPlugin()], diagnostics: [] }],
      new Map(),
      undefined,
      (visible) => {
        const completion = createDeferred<void>()
        const start = nativeStarts[nativeCallCount]
        nativeCallCount += 1
        start.resolve({
          visible,
          resolve: () => {
            browserVisible = visible
            completion.resolve()
          },
          reject: () => completion.reject(new Error('native operation failed'))
        })
        return completion.promise
      }
    )
    await state.reload()

    const browserReveal = state.dispatch({
      type: 'view:set',
      viewId: 'works.pi.desktop.browser',
      visible: true
    })
    void browserReveal.catch(() => undefined)
    await nativeStarts[0].promise
    const externalReveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    const latestHide = await nativeStarts[1].promise

    latestHide.resolve()
    await externalReveal

    expect(nativeCallCount).toBe(2)
    expect(browserVisible).toBe(false)
    expect(views).toHaveLength(1)
    expect(views[0].view.visible).toBe(true)
  })

  it('does not let a never-settling browser show block the latest hide', async () => {
    type NativeOperation = { resolve: () => void }
    const nativeStarts = [createDeferred<NativeOperation>(), createDeferred<NativeOperation>()]
    let nativeCallCount = 0
    const { state } = createHarness(
      [{ plugins: [], diagnostics: [] }],
      new Map(),
      undefined,
      () => {
        const completion = createDeferred<void>()
        const start = nativeStarts[nativeCallCount]
        nativeCallCount += 1
        start.resolve({ resolve: () => completion.resolve() })
        return completion.promise
      }
    )
    await state.reload()

    const staleReveal = state.dispatch({
      type: 'view:set',
      viewId: 'works.pi.desktop.browser',
      visible: true
    })
    void staleReveal.catch(() => undefined)
    await nativeStarts[0].promise
    const latestHide = state.dispatch({
      type: 'view:set',
      viewId: 'works.pi.desktop.browser',
      visible: false
    })
    const hideOperation = await nativeStarts[1].promise

    hideOperation.resolve()
    await latestHide

    expect(nativeCallCount).toBe(2)
  })

  it('reconciles late native resolution or rejection without hiding the external view', async () => {
    type NativeOperation = { visible: boolean; resolve: () => void; reject: () => void }
    const nativeStarts = Array.from({ length: 6 }, () => createDeferred<NativeOperation>())
    let browserVisible = false
    let nativeCallCount = 0
    const { state, views } = createHarness(
      [{ plugins: [externalPlugin()], diagnostics: [] }],
      new Map(),
      undefined,
      (visible) => {
        const completion = createDeferred<void>()
        nativeStarts[nativeCallCount].resolve({
          visible,
          resolve: () => {
            browserVisible = visible
            completion.resolve()
          },
          reject: () => completion.reject(new Error('late native failure'))
        })
        nativeCallCount += 1
        return completion.promise
      }
    )
    await state.reload()

    const staleResolveDispatch = state.dispatch({
      type: 'view:set',
      viewId: 'works.pi.desktop.browser',
      visible: true
    })
    void staleResolveDispatch.catch(() => undefined)
    const staleResolve = await nativeStarts[0].promise
    const externalReveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    const latestHide = await nativeStarts[1].promise
    latestHide.resolve()
    await externalReveal

    staleResolve.resolve()
    await vi.waitFor(() => expect(nativeCallCount).toBe(3))
    const resolveReconcile = await nativeStarts[2].promise
    expect(resolveReconcile.visible).toBe(false)
    resolveReconcile.resolve()
    await vi.waitFor(() => expect(browserVisible).toBe(false))

    const staleRejectDispatch = state.dispatch({
      type: 'view:set',
      viewId: 'works.pi.desktop.browser',
      visible: true
    })
    void staleRejectDispatch.catch(() => undefined)
    const staleReject = await nativeStarts[3].promise
    const latestExternalReveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    const latestRejectHide = await nativeStarts[4].promise
    latestRejectHide.resolve()
    await latestExternalReveal
    staleReject.reject()
    await vi.waitFor(() => expect(nativeCallCount).toBe(6))
    const rejectReconcile = await nativeStarts[5].promise
    expect(rejectReconcile.visible).toBe(false)
    rejectReconcile.resolve()
    await vi.waitFor(() => expect(browserVisible).toBe(false))

    expect(browserVisible).toBe(false)
    expect(views).toHaveLength(1)
    expect(views[0].view.visible).toBe(true)
  })

  it('coalesces multiple stale native completions into one reconciliation', async () => {
    type NativeOperation = { visible: boolean; resolve: () => void; reject: () => void }
    const nativeStarts = Array.from({ length: 5 }, () => createDeferred<NativeOperation>())
    let nativeCallCount = 0
    const { state, views } = createHarness(
      [{ plugins: [externalPlugin()], diagnostics: [] }],
      new Map(),
      undefined,
      (visible) => {
        const completion = createDeferred<void>()
        nativeStarts[nativeCallCount].resolve({
          visible,
          resolve: () => completion.resolve(),
          reject: () => completion.reject(new Error('stale native failure'))
        })
        nativeCallCount += 1
        return completion.promise
      }
    )
    await state.reload()

    const staleShowA = state.dispatch({
      type: 'view:set',
      viewId: 'works.pi.desktop.browser',
      visible: true
    })
    void staleShowA.catch(() => undefined)
    const operationA = await nativeStarts[0].promise
    const staleHide = state.dispatch({
      type: 'view:set',
      viewId: 'works.pi.desktop.browser',
      visible: false
    })
    void staleHide.catch(() => undefined)
    const operationB = await nativeStarts[1].promise
    const staleShowC = state.dispatch({
      type: 'view:set',
      viewId: 'works.pi.desktop.browser',
      visible: true
    })
    void staleShowC.catch(() => undefined)
    const operationC = await nativeStarts[2].promise
    const externalReveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    const latestHide = await nativeStarts[3].promise
    latestHide.resolve()
    await externalReveal

    operationA.resolve()
    operationB.resolve()
    operationC.reject()
    await vi.waitFor(() => expect(nativeCallCount).toBe(5))
    const reconciliation = await nativeStarts[4].promise
    expect(reconciliation.visible).toBe(false)
    reconciliation.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(nativeCallCount).toBe(5)
    expect(views[0].view.visible).toBe(true)
  })

  it('invalidates pending creation on context change without blocking a new generation', async () => {
    const { state, starts, attemptCount } = createControlledViewHarness([
      { plugins: [externalPlugin()], diagnostics: [] }
    ])
    await state.reload()
    state.setContext({ projectPath: '/projects/a', sessionId: 'session-a', generation: 1 })

    const staleReveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    const stale = await starts[0].promise
    state.setContext({ projectPath: '/projects/b', sessionId: 'session-b', generation: 2 })
    stale.request.onCrash('stale generation crash')

    expect(stale.request.signal.aborted).toBe(true)
    expect(state.snapshot().diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'plugin-crashed' })
    )

    const currentReveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    void currentReveal.catch(() => undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(attemptCount()).toBe(2)
    const current = await starts[1].promise
    current.resolve()
    await expect(currentReveal).resolves.toBeDefined()

    stale.resolve()
    await expect(staleReveal).rejects.toThrow(/generation|context|abort|stale/i)
    expect(stale.view.destroyed).toBe(true)
    expect(stale.view.visible).toBe(false)
    expect(current.view.destroyed).toBe(false)
    expect(current.view.visible).toBe(true)
  })

  it('invalidates pending creation on reload and ignores its stale crash callback', async () => {
    const plugin = externalPlugin()
    const { state, starts, attemptCount } = createControlledViewHarness([
      { plugins: [plugin], diagnostics: [] },
      { plugins: [externalPlugin()], diagnostics: [] }
    ])
    await state.reload()

    const staleReveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    const stale = await starts[0].promise
    await state.reload()
    stale.request.onCrash('stale reload crash')

    expect(stale.request.signal.aborted).toBe(true)
    expect(state.snapshot().diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'plugin-crashed' })
    )

    const currentReveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    void currentReveal.catch(() => undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(attemptCount()).toBe(2)
    const current = await starts[1].promise
    current.resolve()
    await expect(currentReveal).resolves.toBeDefined()

    stale.resolve()
    await expect(staleReveal).rejects.toThrow(/abort|stale/i)
    expect(stale.view.destroyed).toBe(true)
    expect(stale.view.visible).toBe(false)
    expect(current.view.destroyed).toBe(false)
    expect(current.view.visible).toBe(true)
  })

  it('never registers a pending view from an old root after same-id reload', async () => {
    const nextDiscovery = createDeferred<WorkbenchManifestDiscovery>()
    const { state, starts, attemptCount } = createControlledViewHarness([
      { plugins: [externalPluginAt('/plugins/old', '1.0.0')], diagnostics: [] },
      nextDiscovery.promise
    ])
    await state.reload()

    const staleReveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    const stale = await starts[0].promise
    expect(stale.request.plugin.canonicalRootPath).toBe('/plugins/old')

    const reload = state.reload()
    await Promise.resolve()
    expect(stale.request.signal.aborted).toBe(true)
    nextDiscovery.resolve({
      plugins: [externalPluginAt('/plugins/new', '2.0.0')],
      diagnostics: []
    })
    await reload

    const currentReveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    void currentReveal.catch(() => undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(attemptCount()).toBe(2)
    const current = await starts[1].promise
    expect(current.request.plugin.canonicalRootPath).toBe('/plugins/new')
    current.resolve()
    await currentReveal

    stale.resolve()
    await expect(staleReveal).rejects.toThrow(/abort|stale/i)
    expect(stale.view.destroyed).toBe(true)
    expect(stale.view.visible).toBe(false)
    expect(current.view.destroyed).toBe(false)
    expect(current.view.visible).toBe(true)
  })

  it('invalidates pending creation when the external plugin is disabled', async () => {
    const { state, starts, attemptCount } = createControlledViewHarness([
      { plugins: [externalPlugin()], diagnostics: [] }
    ])
    await state.reload()

    const staleReveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    const stale = await starts[0].promise
    await state.dispatch({
      type: 'plugin:set-enabled',
      pluginId: 'acme.notes',
      desktopEnabled: false
    })
    stale.request.onCrash('stale disabled-plugin crash')

    expect(stale.request.signal.aborted).toBe(true)
    expect(state.snapshot().diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'plugin-crashed' })
    )

    await state.dispatch({
      type: 'plugin:set-enabled',
      pluginId: 'acme.notes',
      desktopEnabled: true
    })
    const currentReveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    void currentReveal.catch(() => undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(attemptCount()).toBe(2)
    const current = await starts[1].promise
    current.resolve()
    await expect(currentReveal).resolves.toBeDefined()

    stale.resolve()
    await expect(staleReveal).rejects.toThrow(/abort|stale/i)
    expect(stale.view.destroyed).toBe(true)
    expect(stale.view.visible).toBe(false)
    expect(current.view.destroyed).toBe(false)
    expect(current.view.visible).toBe(true)
  })

  it('invalidates pending creation on dispose and ignores all late callbacks', async () => {
    const { state, starts } = createControlledViewHarness([
      { plugins: [externalPlugin()], diagnostics: [] }
    ])
    await state.reload()

    const staleReveal = state.dispatch({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true
    })
    const stale = await starts[0].promise
    state.dispose()
    stale.request.onCrash('stale disposed-host crash')

    expect(stale.request.signal.aborted).toBe(true)
    expect(state.snapshot().diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'plugin-crashed' })
    )

    stale.resolve()
    await expect(staleReveal).rejects.toThrow(/abort|stale/i)
    expect(stale.view.destroyed).toBe(true)
    expect(stale.view.visible).toBe(false)
  })

  it('makes dispose a terminal barrier for reloads and public state calls', async () => {
    const delayedDiscovery = createDeferred<WorkbenchManifestDiscovery>()
    const { state, stateChanges } = createHarness([delayedDiscovery.promise])
    const reload = state.reload()
    await Promise.resolve()
    const changesBeforeDispose = stateChanges.length

    state.dispose()
    state.dispose()
    delayedDiscovery.resolve({ plugins: [externalPlugin()], diagnostics: [] })
    const staleResult = await reload

    expect(staleResult.plugins.map(({ pluginId }) => pluginId)).toEqual([
      'works.pi.desktop.builtin'
    ])
    expect(state.snapshot().plugins.map(({ pluginId }) => pluginId)).toEqual([
      'works.pi.desktop.builtin'
    ])
    expect(stateChanges).toHaveLength(changesBeforeDispose)
    await expect(state.reload()).rejects.toThrow(/disposed/i)
    await expect(state.dispatch({ type: 'state:get' })).rejects.toThrow(/disposed/i)
    await expect(state.setPackageRoots([])).rejects.toThrow(/disposed/i)
    expect(() => state.setContext({ projectPath: null, sessionId: null, generation: 1 })).toThrow(
      /disposed/i
    )
    expect(() => state.panelContext('acme.notes.panel')).toThrow(/disposed/i)
  })

  it('swallows synchronous and asynchronous browser hide failures during dispose', async () => {
    const synchronous = createHarness(
      [{ plugins: [], diagnostics: [] }],
      new Map(),
      undefined,
      (visible) => {
        if (!visible) throw new Error('sync browser hide failed')
      }
    )
    await synchronous.state.reload()
    await synchronous.state.dispatch({
      type: 'view:set',
      viewId: 'works.pi.desktop.browser',
      visible: true
    })
    expect(() => synchronous.state.dispose()).not.toThrow()

    const asynchronous = createHarness(
      [{ plugins: [], diagnostics: [] }],
      new Map(),
      undefined,
      (visible) => (visible ? undefined : Promise.reject(new Error('async browser hide failed')))
    )
    await asynchronous.state.reload()
    await asynchronous.state.dispatch({
      type: 'view:set',
      viewId: 'works.pi.desktop.browser',
      visible: true
    })
    asynchronous.state.dispose()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
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
    await expect(
      state.dispatch({
        type: 'plugin:set-enabled',
        pluginId: 'acme.notes',
        desktopEnabled: true
      })
    ).rejects.toThrow(/restart/i)
    expect(state.snapshot().plugins[1]).toMatchObject({
      desktopEnabled: false,
      diagnostics: [expect.objectContaining({ code: 'plugin-crash-disabled' })]
    })
  })
})
