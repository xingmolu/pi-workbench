import { describe, expect, it, vi } from 'vitest'
import { workbenchSnapshotSchema } from '../shared/workbench-schemas'
import type { ValidatedWorkbenchPlugin } from './workbench-manifest'
import { createWorkbenchHostState, type WorkbenchPluginRuntime } from './workbench-host-state'
import type { RuntimePlugin } from './plugin-runtime'

function codePlugin(permissions: string[]): ValidatedWorkbenchPlugin {
  return {
    pluginId: 'acme.git',
    name: 'Git',
    version: '1.0.0',
    requestedPermissions: permissions,
    source: 'test',
    scope: 'user',
    hasExecutablePiResources: false,
    canonicalRootPath: '/plugins/git',
    manifestPath: '/plugins/git/pi-desktop.json',
    canonicalMainPath: '/plugins/git/main.js',
    commands: [{ id: 'commit', title: 'Commit', keywords: [] }],
    workbench: [
      {
        contribution: {
          pluginId: 'acme.git',
          viewId: 'acme.git.changes',
          title: 'Changes',
          icon: 'git-review',
          activation: 'onApp',
          surface: { kind: 'sandboxed-web' }
        },
        canonicalEntryPath: '/plugins/git/changes.html'
      }
    ]
  }
}

function setup(plugins: ValidatedWorkbenchPlugin[], persisted = new Map<string, unknown>()) {
  const synced: RuntimePlugin[][] = []
  const runtime: WorkbenchPluginRuntime = {
    sync: (next) => synced.push([...next]),
    status: () => 'running',
    commands: () => [
      {
        pluginId: 'acme.git',
        pluginName: 'Git',
        commandId: 'commit',
        title: 'Commit',
        keywords: []
      }
    ],
    runCommand: vi.fn(async () => undefined)
  }
  let discovered = plugins
  const state = createWorkbenchHostState({
    appVersion: '0.1.0',
    userRoots: async () => [],
    discover: async () => ({ plugins: discovered, diagnostics: [] }),
    store: { get: (key) => persisted.get(key), set: (key, value) => persisted.set(key, value) },
    createView: async () => {
      throw new Error('unused')
    },
    nativeViews: { browser: { setView: () => undefined } },
    runtime
  })
  return {
    state,
    runtime,
    synced,
    persisted,
    replace: (next: ValidatedWorkbenchPlugin[]) => {
      discovered = next
    }
  }
}

const git = (snapshot: ReturnType<ReturnType<typeof setup>['state']['snapshot']>) =>
  snapshot.plugins.find(({ pluginId }) => pluginId === 'acme.git')!

describe('plugin grants', () => {
  it('keeps plugins that run code off until the user enables them', async () => {
    const { state, synced } = setup([codePlugin(['ui.view', 'notify'])])
    const snapshot = await state.reload()
    expect(workbenchSnapshotSchema.safeParse(snapshot).success).toBe(true)
    expect(git(snapshot)).toMatchObject({
      desktopEnabled: false,
      runtime: { hasMain: true, grantedPermissions: [], needsGrant: false }
    })
    expect(snapshot.contributions.some(({ viewId }) => viewId === 'acme.git.changes')).toBe(false)
    expect(snapshot.commands).toEqual([])
    expect(synced.at(-1)).toEqual([])
  })

  it('treats enabling as granting the declared, supported permissions', async () => {
    const { state, synced, persisted } = setup([codePlugin(['ui.view', 'notify', 'net.websocket'])])
    await state.reload()
    const { state: snapshot } = await state.dispatch({
      type: 'plugin:set-enabled',
      pluginId: 'acme.git',
      desktopEnabled: true
    })
    expect(git(snapshot)).toMatchObject({
      desktopEnabled: true,
      runtime: { grantedPermissions: ['ui.view', 'notify'] }
    })
    expect(persisted.get('workbenchPluginGrants')).toEqual({ 'acme.git': ['ui.view', 'notify'] })
    const [started] = synced.at(-1)!
    expect([...started.granted].sort()).toEqual(['notify', 'ui.view'])
    expect(started.views.get('changes')).toBe('acme.git.changes')
    expect(snapshot.commands?.map(({ commandId }) => commandId)).toEqual(['commit'])
  })

  it('pauses a plugin whose requested permissions grew until it is re-granted', async () => {
    const persisted = new Map<string, unknown>([
      ['workbenchDesktopEnabled', { 'acme.git': true }],
      ['workbenchPluginGrants', { 'acme.git': ['ui.view'] }]
    ])
    const { state, synced } = setup([codePlugin(['ui.view', 'git.write'])], persisted)
    const snapshot = await state.reload()
    expect(git(snapshot)).toMatchObject({ desktopEnabled: false, runtime: { needsGrant: true } })
    expect(synced.at(-1)).toEqual([])
  })

  it('runs commands only for enabled plugins and revokes grants on disable', async () => {
    const { state, runtime, persisted } = setup([codePlugin(['ui.view'])])
    await state.reload()
    await expect(
      state.dispatch({ type: 'plugin:command:run', pluginId: 'acme.git', commandId: 'commit' })
    ).rejects.toThrow('插件未启用')
    await state.dispatch({ type: 'plugin:set-enabled', pluginId: 'acme.git', desktopEnabled: true })
    await state.dispatch({ type: 'plugin:command:run', pluginId: 'acme.git', commandId: 'commit' })
    expect(runtime.runCommand).toHaveBeenCalledWith('acme.git', 'commit')
    await state.dispatch({
      type: 'plugin:set-enabled',
      pluginId: 'acme.git',
      desktopEnabled: false
    })
    expect(persisted.get('workbenchPluginGrants')).toEqual({})
  })

  it('leaves view-only plugins default-on without a grant', async () => {
    const viewOnly = {
      ...codePlugin(['ui.view', 'clipboard-read']),
      canonicalMainPath: undefined,
      commands: []
    }
    const { state } = setup([viewOnly])
    const snapshot = await state.reload()
    expect(git(snapshot).desktopEnabled).toBe(true)
    expect(git(snapshot).runtime).toBeUndefined()
  })
})
