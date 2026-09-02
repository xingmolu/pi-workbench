import { describe, expect, it, vi } from 'vitest'
import { WORKBENCH_PANEL_STATE_MAX_BYTES } from './workbench-contracts'
import {
  pluginPanelCommandSchema,
  pluginPanelCommandResultSchema,
  pluginPanelContextSchema,
  pluginPanelStateSchema,
  workbenchCommandSchema,
  workbenchCommandResultSchema,
  workbenchEventSchema,
  workbenchSnapshotSchema
} from './workbench-schemas'

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
    },
    {
      pluginId: 'acme.notes',
      name: 'Acme Notes',
      version: '1.0.0',
      source: 'user-package',
      scope: 'user',
      builtin: false,
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
        contributions: [contribution, { ...contribution }]
      }).success
    ).toBe(false)
  })

  it('rejects duplicate plugin ids and orphan contributions', () => {
    const cases = [
      {
        ...snapshot,
        plugins: [snapshot.plugins[0], { ...snapshot.plugins[1], pluginId: 'pi.desktop.builtin' }]
      },
      {
        ...snapshot,
        contributions: [{ ...contribution, pluginId: 'missing.plugin' }]
      }
    ]

    for (const value of cases) expect(workbenchSnapshotSchema.safeParse(value).success).toBe(false)
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

  it('rejects a huge string before whole-value serialization', () => {
    const stringify = vi.spyOn(JSON, 'stringify')
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    let success = true
    let stringifyCalls = -1
    let encodeCalls = -1
    try {
      success = pluginPanelStateSchema.safeParse(
        'x'.repeat(WORKBENCH_PANEL_STATE_MAX_BYTES + 1)
      ).success
      stringifyCalls = stringify.mock.calls.length
      encodeCalls = encode.mock.calls.length
    } finally {
      stringify.mockRestore()
      encode.mockRestore()
    }

    expect(success).toBe(false)
    expect(stringifyCalls).toBe(0)
    expect(encodeCalls).toBe(0)
  })

  it('rejects aggregate large string values and keys before whole-value serialization', () => {
    const cases = [
      { first: 'x'.repeat(17_000), second: 'y'.repeat(17_000) },
      { ['a'.repeat(17_000)]: null, ['b'.repeat(17_000)]: null }
    ]

    for (const value of cases) {
      const stringify = vi.spyOn(JSON, 'stringify')
      let success = true
      let stringifyCalls = -1
      try {
        success = pluginPanelStateSchema.safeParse(value).success
        stringifyCalls = stringify.mock.calls.length
      } finally {
        stringify.mockRestore()
      }

      expect(success).toBe(false)
      expect(stringifyCalls).toBe(0)
    }
  })

  it('never throws and rejects cyclic or excessively complex panel state', () => {
    const context = {
      pluginId: 'acme.notes',
      viewId: 'notes',
      projectPath: null,
      sessionId: null,
      generation: 0
    }
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic

    let deep: unknown = null
    for (let index = 0; index < 65; index += 1) deep = { child: deep }

    const cases = [cyclic, deep, new Array(4096).fill(null), { value: Number.POSITIVE_INFINITY }]
    for (const value of cases) {
      let result: ReturnType<typeof pluginPanelCommandSchema.safeParse> | undefined
      expect(() => {
        result = pluginPanelCommandSchema.safeParse({ type: 'state:set', context, value })
      }).not.toThrow()
      expect(result?.success).toBe(false)
    }
  })

  it('rejects non-plain containers and non-data properties', () => {
    class StateContainer {
      value = 'not-plain'
    }
    const withSymbol = { value: 'visible', [Symbol('hidden')]: 'hidden' }
    const withGetter = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 'computed'
    })
    const sparse = new Array(2)
    sparse[1] = 'value'

    for (const value of [
      new Date(),
      new Map(),
      new StateContainer(),
      withSymbol,
      withGetter,
      sparse
    ]) {
      expect(pluginPanelStateSchema.safeParse(value).success).toBe(false)
    }
  })

  it('accepts state/reveal events, command results, panel context and panel results', () => {
    const context = {
      pluginId: 'acme.notes',
      viewId: 'notes',
      projectPath: '/workspace/project',
      sessionId: 'session-1',
      generation: 7
    } as const
    const cases: Array<[string, { safeParse: (value: unknown) => { success: boolean } }, unknown]> =
      [
        ['state event', workbenchEventSchema, { type: 'state', data: snapshot }],
        [
          'reveal event',
          workbenchEventSchema,
          { type: 'reveal', viewId: 'notes', context: { noteId: 'note-1' } }
        ],
        ['reveal event without context', workbenchEventSchema, { type: 'reveal', viewId: 'notes' }],
        ['command result', workbenchCommandResultSchema, { state: snapshot }],
        ['panel context', pluginPanelContextSchema, context],
        ['panel context command', pluginPanelCommandSchema, { type: 'context:get' }],
        ['panel state command', pluginPanelCommandSchema, { type: 'state:get', context }],
        ['context result', pluginPanelCommandResultSchema, { type: 'context', context }],
        [
          'state result',
          pluginPanelCommandResultSchema,
          { type: 'state', context, value: { noteId: 'note-1' } }
        ],
        ['stored result', pluginPanelCommandResultSchema, { type: 'state:stored', context }]
      ]

    for (const [name, schema, value] of cases) {
      expect(schema.safeParse(value).success, name).toBe(true)
    }
  })

  it('rejects unknown fields at every Workbench boundary', () => {
    const context = {
      pluginId: 'acme.notes',
      viewId: 'notes',
      projectPath: null,
      sessionId: null,
      generation: 0
    }
    const cases: Array<[string, { safeParse: (value: unknown) => { success: boolean } }, unknown]> =
      [
        ['snapshot', workbenchSnapshotSchema, { ...snapshot, entryPath: '/unsafe/panel.js' }],
        ['command', workbenchCommandSchema, { type: 'state:get', extra: true }],
        ['command result', workbenchCommandResultSchema, { state: snapshot, extra: true }],
        ['event', workbenchEventSchema, { type: 'reveal', viewId: 'notes', extra: true }],
        ['panel context', pluginPanelContextSchema, { ...context, extra: true }],
        ['panel command', pluginPanelCommandSchema, { type: 'context:get', extra: true }],
        [
          'panel result',
          pluginPanelCommandResultSchema,
          { type: 'state:stored', context, extra: true }
        ]
      ]

    for (const [name, schema, value] of cases) {
      expect(schema.safeParse(value).success, name).toBe(false)
    }
  })
})
