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
    agentTools: [],
    skillPaths: [],
    mcpServers: {},
    settings: [],
    themes: [],
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

  it('trusts bundled plugins: on by default, granted what they request, and disableable', async () => {
    const bundled = {
      ...codePlugin(['git.read', 'git.write', 'git.push']),
      scope: 'bundled' as const
    }
    const { state, synced, persisted } = setup([bundled])
    await state.reload()
    expect(git(state.snapshot())).toMatchObject({
      scope: 'bundled',
      desktopEnabled: true,
      runtime: { needsGrant: false, grantedPermissions: ['git.read', 'git.write', 'git.push'] }
    })
    expect(state.pluginForView('acme.git.changes')?.granted.has('git.push')).toBe(true)
    expect(synced.at(-1)?.map(({ pluginId }) => pluginId)).toEqual(['acme.git'])

    await state.dispatch({
      type: 'plugin:set-enabled',
      pluginId: 'acme.git',
      desktopEnabled: false
    })
    expect(git(state.snapshot()).desktopEnabled).toBe(false)
    expect(state.pluginForView('acme.git.changes')).toBeNull()
    expect(synced.at(-1)).toEqual([])
    // Grants are implied by shipping with the app, never stored.
    expect(persisted.get('workbenchPluginGrants') ?? {}).toEqual({})

    await state.dispatch({ type: 'plugin:set-enabled', pluginId: 'acme.git', desktopEnabled: true })
    expect(git(state.snapshot()).desktopEnabled).toBe(true)
  })

  it('discovers bundled roots first and keeps other sources from relabeling them', async () => {
    const seen: { path: string; scope: string }[][] = []
    const state = createWorkbenchHostState({
      appVersion: '0.1.0',
      userRoots: async () => [
        {
          path: '/app/plugins/git',
          source: '本机插件',
          scope: 'user',
          hasExecutablePiResources: false
        },
        {
          path: '/home/me/plugins/x',
          source: '本机插件',
          scope: 'user',
          hasExecutablePiResources: false
        }
      ],
      bundledRoots: async () => [
        {
          path: '/app/plugins/git',
          source: '内置插件',
          scope: 'bundled',
          hasExecutablePiResources: false
        }
      ],
      canonicalizeRoot: async (path) => path,
      discover: async ({ roots }) => {
        seen.push(roots.map(({ path, scope }) => ({ path, scope })))
        return { plugins: [], diagnostics: [] }
      },
      store: { get: () => undefined, set: () => undefined },
      createView: async () => {
        throw new Error('unused')
      },
      nativeViews: { browser: { setView: () => undefined } }
    })
    await state.reload()
    expect(seen.at(-1)).toEqual([
      { path: '/app/plugins/git', scope: 'bundled' },
      { path: '/home/me/plugins/x', scope: 'user' }
    ])
  })

  it('contributes agent tools, skills and MCP servers only behind their grants', async () => {
    const agentPlugin = {
      ...codePlugin(['agent.tools', 'mcp.local']),
      agentTools: [
        {
          name: 'lookup',
          title: 'Lookup',
          description: 'Look up',
          parameters: { type: 'object' },
          readOnly: true
        }
      ],
      skillPaths: ['/plugins/git/skills'],
      mcpServers: {
        local: { command: 'node', args: ['/plugins/git/server.js'] },
        remote: { url: 'https://example.com/mcp' }
      }
    }
    const { state } = setup([agentPlugin])
    await state.reload()
    expect(state.agentContributions()).toEqual({ tools: [], skillPaths: [], mcpServers: {} })

    await state.dispatch({ type: 'plugin:set-enabled', pluginId: 'acme.git', desktopEnabled: true })
    expect(state.agentContributions()).toEqual({
      tools: [
        {
          pluginId: 'acme.git',
          pluginName: 'Git',
          name: 'lookup',
          toolName: 'acme_git__lookup',
          title: 'Lookup',
          description: 'Look up',
          parameters: { type: 'object' },
          readOnly: true
        }
      ],
      // Not granted agent.skills or mcp.remote.
      skillPaths: [],
      mcpServers: { acme_git_local: { command: 'node', args: ['/plugins/git/server.js'] } }
    })
  })

  it('lets callers wait for a registry reload in flight', async () => {
    let finish: () => void = () => undefined
    const state = createWorkbenchHostState({
      appVersion: '0.1.0',
      userRoots: async () => [],
      discover: () =>
        new Promise((resolve) => {
          finish = () => resolve({ plugins: [], diagnostics: [] })
        }),
      store: { get: () => undefined, set: () => undefined },
      createView: async () => {
        throw new Error('unused')
      },
      nativeViews: { browser: { setView: () => undefined } }
    })
    void state.reload()
    let waited = false
    const waiting = state.whenLoaded().then(() => {
      waited = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(waited).toBe(false)
    finish()
    await waiting
    expect(waited).toBe(true)
  })

  it('stores declared settings, validates them and feeds MCP setting references', async () => {
    const withSettings = {
      ...codePlugin(['mcp.local']),
      settings: [
        { key: 'token', title: 'Token', type: 'string' as const, default: '' },
        {
          key: 'mode',
          title: 'Mode',
          type: 'select' as const,
          options: [
            { value: 'fast', label: 'Fast' },
            { value: 'slow', label: 'Slow' }
          ]
        }
      ],
      mcpServers: { docs: { command: 'node', env: { TOKEN: '${setting:token}' } } }
    }
    const { state, persisted } = setup([withSettings])
    await state.reload()
    await state.dispatch({ type: 'plugin:set-enabled', pluginId: 'acme.git', desktopEnabled: true })
    expect(state.pluginSettings('acme.git')).toEqual({ token: '', mode: 'fast' })

    await state.dispatch({
      type: 'plugin:settings:set',
      pluginId: 'acme.git',
      key: 'token',
      value: 'secret'
    })
    expect(git(state.snapshot()).settings).toEqual([
      { key: 'token', title: 'Token', type: 'string', value: 'secret' },
      {
        key: 'mode',
        title: 'Mode',
        type: 'select',
        value: 'fast',
        options: [
          { value: 'fast', label: 'Fast' },
          { value: 'slow', label: 'Slow' }
        ]
      }
    ])
    expect(persisted.get('workbenchPluginSettings')).toEqual({ 'acme.git': { token: 'secret' } })
    expect(state.agentContributions().mcpServers).toEqual({
      acme_git_docs: { command: 'node', env: { TOKEN: 'secret' } }
    })

    expect(() => state.setPluginSettings('acme.git', { mode: 'turbo' })).toThrow(/类型/)
    expect(() => state.setPluginSettings('acme.git', { other: 1 })).toThrow(/未在 manifest/)
    expect(state.setPluginSettings('acme.git', { mode: 'slow' })).toEqual({
      token: 'secret',
      mode: 'slow'
    })
  })

  it('offers themes only from enabled plugins granted ui.theme', async () => {
    const themed = {
      ...codePlugin(['ui.theme']),
      canonicalMainPath: undefined,
      commands: [],
      themes: [
        { id: 'dusk', label: '黄昏', base: 'dark' as const, tokens: { '--canvas': '#101014' } }
      ]
    }
    const { state } = setup([themed])
    await state.reload()
    expect(state.snapshot().themes).toEqual([])
    await state.dispatch({ type: 'plugin:set-enabled', pluginId: 'acme.git', desktopEnabled: true })
    expect(state.snapshot().themes).toEqual([
      {
        id: 'acme.git/dusk',
        pluginId: 'acme.git',
        pluginName: 'Git',
        label: '黄昏',
        base: 'dark',
        tokens: { '--canvas': '#101014' }
      }
    ])
    expect(workbenchSnapshotSchema.safeParse(state.snapshot()).success).toBe(true)
  })
})
