import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizePermissions,
  normalizePiDesktopManifest,
  resolveSettingPlaceholders
} from './manifest-compat'
import { discoverWorkbenchManifests } from './workbench-manifest'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A manifest in documented shape, written for this test. */
const PI_MANIFEST = {
  schemaVersion: 1,
  id: 'compat.sample',
  name: 'Compat Sample',
  version: '0.3.0',
  author: { name: 'Someone' },
  main: 'main.js',
  ui: { panel: 'panel/index.html', width: 400, title: { en: 'Sample', 'zh-CN': '示例' } },
  contributes: {
    commands: [{ id: 'sample.open', title: 'Sample: Open', category: 'Demo' }],
    agentTools: [
      {
        name: 'echo_text',
        description: 'Echo text',
        risk: 'low',
        schema: { type: 'object', properties: { text: { type: 'string' } } }
      }
    ],
    skills: ['./skills/guide.md', { path: 'skills/more' }],
    settings: [
      { key: 'token', title: 'Token', type: 'string', default: '' },
      { key: 'mode', title: 'Mode', type: 'select', options: ['fast', 'slow'], default: 'fast' }
    ],
    mcpServers: [
      {
        id: 'docs',
        label: 'Docs',
        transport: 'stdio',
        command: 'bin/docs-server',
        args: ['--stdio'],
        env: { DOCS_TOKEN: { setting: 'token' } }
      }
    ],
    themes: [{ id: 'dark', label: 'Dark', path: 'themes/dark.css' }],
    services: [{ id: 'watcher' }],
    bus: { publish: ['a.b'] }
  },
  permissions: [
    'ui.panel',
    'agent.tool.register',
    'agent.prompt.inject',
    'mcp.server.local',
    'bus.publish'
  ],
  activationEvents: ['onStartup'],
  fs: { read: { scope: ['**/*'] } },
  net: { domains: [] }
}

describe('manifest.json manifest compatibility', () => {
  it('maps permission names onto ours', () => {
    expect(
      normalizePermissions(['agent.tool.register', 'agent.prompt.inject', 'ui.panel', 'ui.view'])
    ).toEqual(['agent.tools', 'agent.skills', 'ui.view'])
  })

  it('rewrites manifest.json fields and reports what it drops', () => {
    const { value, warnings } = normalizePiDesktopManifest(PI_MANIFEST)
    expect(value).toMatchObject({
      engines: { piDesktop: '*' },
      permissions: ['ui.view', 'agent.tools', 'agent.skills', 'mcp.local', 'bus.publish'],
      contributes: {
        views: [{ id: 'panel', entry: 'panel/index.html', activation: 'onApp' }],
        commands: [{ id: 'sample.open', title: 'Sample: Open' }],
        agentTools: [{ name: 'echo_text', parameters: { type: 'object' } }],
        skills: ['./skills/guide.md', 'skills/more'],
        mcpServers: {
          docs: {
            command: '${pluginRoot}/bin/docs-server',
            args: ['--stdio'],
            env: { DOCS_TOKEN: '${setting:token}' }
          }
        }
      }
    })
    expect(value).not.toHaveProperty('author')
    expect(value).not.toHaveProperty('ui')
    expect(warnings.join('\n')).toMatch(/主题[\s\S]*常驻服务[\s\S]*消息总线[\s\S]*独立窗口/)
  })

  it('resolves setting references', () => {
    expect(resolveSettingPlaceholders('Bearer ${setting:token}', { token: 'abc' })).toBe(
      'Bearer abc'
    )
    expect(resolveSettingPlaceholders('${setting:missing}', {})).toBe('')
  })

  it('discovers a plugin from manifest.json and ignores unrelated manifest.json files', async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'pi-compat-')))
    roots.push(parent)
    const plugin = join(parent, 'sample')
    await mkdir(join(plugin, 'panel'), { recursive: true })
    await mkdir(join(plugin, 'skills', 'more'), { recursive: true })
    await writeFile(join(plugin, 'panel', 'index.html'), '<!doctype html><title>p</title>')
    await writeFile(join(plugin, 'skills', 'guide.md'), '---\ndescription: guide\n---\n')
    await writeFile(join(plugin, 'main.js'), 'module.exports = {}')
    await writeFile(join(plugin, 'manifest.json'), JSON.stringify(PI_MANIFEST))
    const webApp = join(parent, 'web-app')
    await mkdir(webApp)
    await writeFile(join(webApp, 'manifest.json'), JSON.stringify({ name: 'PWA', icons: [] }))

    const { plugins, diagnostics } = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: [plugin, webApp].map((path) => ({
        path,
        source: 'test',
        scope: 'user' as const,
        hasExecutablePiResources: false
      }))
    })
    expect(plugins).toHaveLength(1)
    const [sample] = plugins
    expect(sample.manifestPath).toBe(join(plugin, 'manifest.json'))
    expect(sample.workbench.map(({ contribution }) => contribution)).toEqual([
      expect.objectContaining({
        viewId: 'compat.sample.panel',
        title: '示例',
        activation: 'onApp'
      })
    ])
    expect(sample.commands).toEqual([{ id: 'sample.open', title: 'Sample: Open', keywords: [] }])
    expect(sample.skillPaths).toEqual([
      join(plugin, 'skills', 'guide.md'),
      join(plugin, 'skills', 'more')
    ])
    expect(sample.mcpServers.docs.command).toBe(join(plugin, 'bin', 'docs-server'))
    expect(sample.settings.map(({ key }) => key)).toEqual(['token', 'mode'])
    expect(sample.settings[1].options).toEqual([
      { value: 'fast', label: 'fast' },
      { value: 'slow', label: 'slow' }
    ])
    expect(
      diagnostics.every(({ severity, code }) => severity === 'warning' && code === 'compat-ignored')
    ).toBe(true)
    // Themes, services, bus, the floating panel, and inline scripts in its pages.
    expect(diagnostics).toHaveLength(5)
    expect(sample.piDesktopCompat).toBe(true)
  })
})
