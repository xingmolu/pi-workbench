import { describe, expect, it } from 'vitest'
import { WORKBENCH_PANEL_STATE_MAX_BYTES } from './workbench-contracts'
import {
  piPackageRootsMessageSchema,
  pluginPanelCommandSchema,
  workbenchCommandSchema,
  workbenchSnapshotSchema
} from './schemas'

const contribution = {
  pluginId: 'pi.desktop.builtin',
  viewId: 'files',
  title: 'Files',
  icon: 'files',
  activation: 'onProject',
  surface: { kind: 'first-party', adapter: 'files' }
} as const

const snapshot = {
  revision: 3,
  plugins: [
    {
      pluginId: 'pi.desktop.builtin',
      name: 'Pi Desktop',
      version: '0.1.0',
      description: 'Built-in Workbench views',
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
    contribution,
    {
      pluginId: 'pi.desktop.builtin',
      viewId: 'browser',
      title: 'Browser',
      icon: 'browser',
      activation: 'onApp',
      surface: { kind: 'native-view', adapter: 'browser' }
    },
    {
      pluginId: 'acme.notes',
      viewId: 'notes',
      title: 'Notes',
      icon: 'plugin',
      activation: 'onApp',
      surface: { kind: 'sandboxed-web' }
    }
  ],
  diagnostics: []
} as const

describe('Workbench schemas', () => {
  it('accepts a serializable Workbench snapshot and the core commands', () => {
    expect(workbenchSnapshotSchema.parse(snapshot)).toEqual(snapshot)

    expect(workbenchCommandSchema.parse({ type: 'state:get' })).toEqual({ type: 'state:get' })
    expect(workbenchCommandSchema.parse({ type: 'plugins:reload' })).toEqual({
      type: 'plugins:reload'
    })
    expect(
      workbenchCommandSchema.parse({
        type: 'plugin:set-enabled',
        pluginId: 'acme.notes',
        desktopEnabled: false
      })
    ).toEqual({
      type: 'plugin:set-enabled',
      pluginId: 'acme.notes',
      desktopEnabled: false
    })
    expect(
      workbenchCommandSchema.parse({
        type: 'view:set',
        viewId: 'browser',
        visible: true,
        bounds: { x: 0, y: 48, width: 720, height: 900 }
      })
    ).toEqual({
      type: 'view:set',
      viewId: 'browser',
      visible: true,
      bounds: { x: 0, y: 48, width: 720, height: 900 }
    })
  })

  it('rejects unknown surface kinds and adapters', () => {
    expect(
      workbenchSnapshotSchema.safeParse({
        ...snapshot,
        contributions: [{ ...contribution, surface: { kind: 'electron-webview' } }]
      }).success
    ).toBe(false)
    expect(
      workbenchSnapshotSchema.safeParse({
        ...snapshot,
        contributions: [{ ...contribution, surface: { kind: 'native-view', adapter: 'terminal' } }]
      }).success
    ).toBe(false)
    expect(
      workbenchSnapshotSchema.safeParse({
        ...snapshot,
        contributions: [{ ...contribution, icon: 'arbitrary-icon-name' }]
      }).success
    ).toBe(false)
  })

  it('rejects duplicate globally addressed view ids', () => {
    expect(
      workbenchSnapshotSchema.safeParse({
        ...snapshot,
        contributions: [contribution, { ...contribution, pluginId: 'acme.duplicate' }]
      }).success
    ).toBe(false)
  })

  it('rejects unsafe native-view bounds', () => {
    const command = {
      type: 'view:set',
      viewId: 'browser',
      visible: true
    } as const

    for (const bounds of [
      { x: -1, y: 0, width: 100, height: 100 },
      { x: 0, y: 0, width: 0, height: 100 },
      { x: 0, y: 0, width: 100, height: Number.NaN },
      { x: 0, y: 0, width: 1_000_000, height: 100 }
    ]) {
      expect(workbenchCommandSchema.safeParse({ ...command, bounds }).success).toBe(false)
    }
  })

  it('accepts JSON-only panel state up to 32 KiB', () => {
    expect(
      pluginPanelCommandSchema.parse({
        type: 'state:set',
        context: {
          pluginId: 'acme.notes',
          viewId: 'notes',
          projectPath: '/workspace/project',
          sessionId: 'session-1',
          generation: 7
        },
        value: { selected: 2, filters: ['todo', null], compact: true }
      })
    ).toMatchObject({ type: 'state:set', value: { selected: 2 } })

    const exact = 'x'.repeat(WORKBENCH_PANEL_STATE_MAX_BYTES - 2)
    expect(
      pluginPanelCommandSchema.safeParse({
        type: 'state:set',
        context: {
          pluginId: 'acme.notes',
          viewId: 'notes',
          projectPath: null,
          sessionId: null,
          generation: 0
        },
        value: exact
      }).success
    ).toBe(true)
  })

  it('rejects oversized or non-JSON panel state', () => {
    const context = {
      pluginId: 'acme.notes',
      viewId: 'notes',
      projectPath: null,
      sessionId: null,
      generation: 0
    }
    expect(
      pluginPanelCommandSchema.safeParse({
        type: 'state:set',
        context,
        value: 'x'.repeat(WORKBENCH_PANEL_STATE_MAX_BYTES - 1)
      }).success
    ).toBe(false)
    expect(
      pluginPanelCommandSchema.safeParse({
        type: 'state:set',
        context,
        value: { invalid: Number.NaN }
      }).success
    ).toBe(false)
    expect(
      pluginPanelCommandSchema.safeParse({
        type: 'state:set',
        context,
        value: { invalid: undefined }
      }).success
    ).toBe(false)
  })
})

describe('Pi package-root message schema', () => {
  it('accepts trusted absolute package roots', () => {
    const message = {
      type: 'desktop-plugin-roots',
      sessionId: 'session-1',
      generation: 4,
      roots: [
        {
          path: '/Users/me/.pi/agent/extensions/example',
          source: 'package-discovery',
          scope: 'user',
          hasExecutablePiResources: true
        },
        {
          path: 'C:\\Users\\me\\project\\.pi\\extensions\\example',
          source: 'project-package-discovery',
          scope: 'project',
          hasExecutablePiResources: false
        }
      ]
    } as const

    expect(piPackageRootsMessageSchema.parse(message)).toEqual(message)
  })

  it('rejects malformed or renderer-shaped package-root messages', () => {
    expect(
      piPackageRootsMessageSchema.safeParse({
        type: 'desktop-plugin-roots',
        sessionId: null,
        generation: 0,
        roots: [
          {
            path: '../relative/plugin',
            source: 'package-discovery',
            scope: 'user',
            hasExecutablePiResources: false
          }
        ]
      }).success
    ).toBe(false)
    expect(
      piPackageRootsMessageSchema.safeParse({
        type: 'desktop-plugin-roots',
        sessionId: null,
        generation: -1,
        roots: []
      }).success
    ).toBe(false)
    expect(
      piPackageRootsMessageSchema.safeParse({
        type: 'desktop-plugin-roots',
        sessionId: null,
        generation: 0,
        roots: [],
        webContents: {}
      }).success
    ).toBe(false)
  })
})
