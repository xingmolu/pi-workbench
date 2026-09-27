import { describe, expect, it } from 'vitest'
import type { WorkbenchDiagnostic } from '../shared/workbench-contracts'
import {
  BUILTIN_WORKBENCH_CONTRIBUTIONS,
  BUILTIN_WORKBENCH_PLUGIN_ID,
  buildWorkbenchRegistrySnapshot,
  findWorkbenchContribution,
  reserveBuiltinWorkbenchRegistry
} from './workbench-contribution-registry'
import type {
  ValidatedWorkbenchEntry,
  ValidatedWorkbenchPlugin,
  WorkbenchManifestDiscovery
} from './workbench-manifest'

function entry(
  viewId: string,
  activation: 'onApp' | 'onProject' = 'onProject'
): ValidatedWorkbenchEntry {
  return {
    canonicalEntryPath: `/plugins/example/${viewId}.html`,
    contribution: {
      pluginId: 'example.plugin',
      viewId,
      title: viewId,
      icon: 'plugin',
      activation,
      surface: { kind: 'sandboxed-web' }
    }
  }
}

function plugin(
  pluginId = 'example.plugin',
  workbench: ValidatedWorkbenchEntry[] = [entry('example.plugin.panel')]
): ValidatedWorkbenchPlugin {
  return {
    commands: [],
    agentTools: [],
    skillPaths: [],
    mcpServers: {},
    pluginId,
    name: pluginId,
    version: '1.0.0',
    description: 'Example',
    requestedPermissions: ['network'],
    source: 'fixture',
    scope: 'user',
    hasExecutablePiResources: false,
    canonicalRootPath: `/plugins/${pluginId}`,
    manifestPath: `/plugins/${pluginId}/pi-desktop.json`,
    workbench: workbench.map((item) => ({
      ...item,
      contribution: { ...item.contribution, pluginId }
    }))
  }
}

function discovery(plugins: ValidatedWorkbenchPlugin[]): WorkbenchManifestDiscovery {
  return { plugins, diagnostics: [] }
}

describe('workbench contribution registry', () => {
  it('reserves the first-party plugin and view identities', () => {
    const builtinPluginCollision = plugin(BUILTIN_WORKBENCH_PLUGIN_ID)
    const builtinViewCollision = plugin('third.party', [
      entry(BUILTIN_WORKBENCH_CONTRIBUTIONS[0].viewId)
    ])
    const valid = plugin('valid.plugin', [entry('valid.plugin.panel')])

    const result = reserveBuiltinWorkbenchRegistry(
      discovery([builtinPluginCollision, builtinViewCollision, valid])
    )

    expect(result.plugins.map(({ pluginId }) => pluginId)).toEqual(['valid.plugin'])
    expect(result.diagnostics).toMatchObject([
      { code: 'reserved-plugin-id', pluginId: BUILTIN_WORKBENCH_PLUGIN_ID },
      {
        code: 'reserved-view-id',
        pluginId: 'third.party',
        viewId: BUILTIN_WORKBENCH_CONTRIBUTIONS[0].viewId
      }
    ])
  })

  it('projects builtins and enabled plugin contributions through the same snapshot', () => {
    const app = plugin('app.plugin', [entry('app.plugin.panel', 'onApp')])
    const project = plugin('project.plugin', [entry('project.plugin.panel', 'onProject')])
    const disabled = plugin('disabled.plugin', [entry('disabled.plugin.panel', 'onApp')])
    const pluginWarning: WorkbenchDiagnostic = {
      severity: 'warning',
      code: 'fixture-warning',
      message: 'fixture',
      pluginId: 'project.plugin'
    }
    const runtimeWarning: WorkbenchDiagnostic = {
      severity: 'warning',
      code: 'runtime-warning',
      message: 'runtime'
    }

    const snapshot = buildWorkbenchRegistrySnapshot({
      revision: 7,
      appVersion: '2.3.4',
      discovery: discovery([app, project, disabled]),
      isDesktopEnabled: (pluginId) => pluginId !== 'disabled.plugin',
      isAvailable: (activation) => activation === 'onApp',
      pluginDiagnostics: (pluginId) =>
        pluginId === 'project.plugin' ? [pluginWarning] : [],
      runtimeDiagnostics: [runtimeWarning]
    })

    expect(snapshot.revision).toBe(7)
    expect(snapshot.plugins[0]).toMatchObject({
      pluginId: BUILTIN_WORKBENCH_PLUGIN_ID,
      version: '2.3.4',
      builtin: true,
      desktopEnabled: true
    })
    expect(snapshot.plugins.find(({ pluginId }) => pluginId === 'disabled.plugin')).toMatchObject({
      desktopEnabled: false
    })
    expect(snapshot.plugins.find(({ pluginId }) => pluginId === 'project.plugin')?.diagnostics).toEqual([
      pluginWarning
    ])
    expect(snapshot.contributions.map(({ viewId }) => viewId)).toEqual([
      'works.pi.desktop.browser',
      'app.plugin.panel'
    ])
    expect(snapshot.diagnostics).toEqual([runtimeWarning])
  })

  it('makes builtin and plugin lookup explicit without exposing manifest traversal to callers', () => {
    const external = plugin('external.plugin', [entry('external.plugin.panel')])
    const registry = discovery([external])

    expect(findWorkbenchContribution(registry, 'works.pi.desktop.files')).toMatchObject({
      kind: 'builtin',
      contribution: { viewId: 'works.pi.desktop.files' }
    })
    expect(findWorkbenchContribution(registry, 'external.plugin.panel')).toMatchObject({
      kind: 'plugin',
      plugin: { pluginId: 'external.plugin' },
      entry: { contribution: { viewId: 'external.plugin.panel' } }
    })
    expect(findWorkbenchContribution(registry, 'missing.panel')).toBeUndefined()
  })
})
