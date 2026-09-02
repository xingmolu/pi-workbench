import { describe, expect, it } from 'vitest'
import type { DesktopPluginSummary } from '../../../shared/contracts'
import {
  INITIAL_PLUGIN_SETTINGS_OPERATION_STATE,
  pluginDesktopToggleCommand,
  pluginSettingsErrorMessage,
  pluginSettingsOperationReducer
} from './plugin-settings'

function plugin(overrides: Partial<DesktopPluginSummary> = {}): DesktopPluginSummary {
  return {
    pluginId: 'acme.notes',
    name: 'Notes',
    version: '1.0.0',
    source: 'user-directory',
    scope: 'user',
    builtin: false,
    desktopEnabled: true,
    hasExecutablePiResources: false,
    requestedPermissions: [],
    diagnostics: [],
    ...overrides
  }
}

describe('Workbench plugin settings behavior', () => {
  it('creates a Desktop-only toggle command for an external plugin', () => {
    expect(pluginDesktopToggleCommand(plugin(), false)).toEqual({
      type: 'plugin:set-enabled',
      pluginId: 'acme.notes',
      desktopEnabled: false
    })
  })

  it('never creates a toggle command for the built-in plugin', () => {
    expect(
      pluginDesktopToggleCommand(
        plugin({ pluginId: 'works.pi.desktop.builtin', builtin: true }),
        false
      )
    ).toBeNull()
  })

  it('moves a failed toggle out of loading and keeps a visible per-plugin error', () => {
    const loading = pluginSettingsOperationReducer(INITIAL_PLUGIN_SETTINGS_OPERATION_STATE, {
      type: 'toggle:start',
      pluginId: 'acme.notes'
    })
    expect(loading.pendingPluginIds).toEqual(['acme.notes'])

    const failed = pluginSettingsOperationReducer(loading, {
      type: 'toggle:failure',
      pluginId: 'acme.notes',
      message: '插件设置未保存：Workbench unavailable'
    })

    expect(failed.pendingPluginIds).toEqual([])
    expect(failed.pluginErrors).toEqual({
      'acme.notes': '插件设置未保存：Workbench unavailable'
    })
  })

  it('turns the third-crash lock into an explicit restart instruction', () => {
    expect(
      pluginSettingsErrorMessage(
        new Error(
          'Workbench plugin was disabled after repeated crashes and requires an app restart'
        )
      )
    ).toBe('插件因连续崩溃已锁定。请重启 Pi Desktop 后再启用。')
  })

  it('tracks reload loading and failure separately from plugin toggles', () => {
    const loading = pluginSettingsOperationReducer(INITIAL_PLUGIN_SETTINGS_OPERATION_STATE, {
      type: 'reload:start'
    })
    expect(loading).toMatchObject({ reloading: true, reloadError: null })

    expect(
      pluginSettingsOperationReducer(loading, {
        type: 'reload:failure',
        message: '插件列表刷新失败：manifest invalid'
      })
    ).toMatchObject({
      reloading: false,
      reloadError: '插件列表刷新失败：manifest invalid'
    })
  })
})
