import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverWorkbenchManifests } from './workbench-manifest'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

async function temporaryPluginRoot(name = 'plugin'): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'pi-desktop-workbench-manifest-'))
  temporaryDirectories.push(parent)
  const root = join(parent, name)
  await mkdir(join(root, 'web'), { recursive: true })
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><title>Notes</title>')
  return root
}

async function writeManifest(root: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const manifest = {
    schemaVersion: 1,
    id: 'acme.notes',
    version: '1.2.3',
    name: 'Acme Notes',
    description: 'A notes panel',
    engines: { piDesktop: '^0.1.0' },
    permissions: ['clipboard-read'],
    contributes: {
      workbench: [
        {
          id: 'acme.notes.panel',
          title: 'Notes',
          icon: 'plugin',
          surface: { kind: 'sandboxed-web', entry: './web/index.html' }
        }
      ]
    },
    ...overrides
  }
  await writeFile(join(root, 'pi-desktop.json'), JSON.stringify(manifest))
}

async function padManifestToBytes(root: string, byteLength: number): Promise<void> {
  const manifestPath = join(root, 'pi-desktop.json')
  const manifest = await readFile(manifestPath, 'utf8')
  const paddingLength = byteLength - Buffer.byteLength(manifest)
  if (paddingLength < 0) throw new Error('Requested manifest size is smaller than its JSON')
  await writeFile(manifestPath, `${manifest}${' '.repeat(paddingLength)}`)
}

describe('discoverWorkbenchManifests', () => {
  it('rejects an invalid caller app version', async () => {
    await expect(
      discoverWorkbenchManifests({ appVersion: 'development', roots: [] })
    ).rejects.toThrow(TypeError)
  })

  it('discovers and validates a plugin without executing its code', async () => {
    const root = await temporaryPluginRoot()
    const executionMarker = join(root, 'plugin-was-executed')
    await writeFile(
      join(root, 'index.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(executionMarker)}, 'executed')`
    )
    await writeManifest(root)
    const canonicalRoot = await realpath(root)

    const result = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: [
        {
          path: root,
          source: 'user-directory',
          scope: 'user',
          hasExecutablePiResources: true
        }
      ]
    })

    expect(result.diagnostics).toEqual([])
    expect(result.plugins).toEqual([
      {
        commands: [],
        agentTools: [],
        skillPaths: [],
        mcpServers: {},
        settings: [],
        pluginId: 'acme.notes',
        name: 'Acme Notes',
        version: '1.2.3',
        description: 'A notes panel',
        requestedPermissions: ['clipboard-read'],
        source: 'user-directory',
        scope: 'user',
        hasExecutablePiResources: true,
        canonicalRootPath: canonicalRoot,
        manifestPath: join(canonicalRoot, 'pi-desktop.json'),
        workbench: [
          {
            contribution: {
              pluginId: 'acme.notes',
              viewId: 'acme.notes.panel',
              title: 'Notes',
              icon: 'plugin',
              activation: 'onProject',
              surface: { kind: 'sandboxed-web' }
            },
            canonicalEntryPath: join(canonicalRoot, 'web', 'index.html')
          }
        ]
      }
    ])
    await expect(readFile(executionMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts both activation values and defaults a missing activation to onProject', async () => {
    const root = await temporaryPluginRoot()
    await writeManifest(root, {
      contributes: {
        workbench: [
          {
            id: 'acme.notes.app',
            title: 'App Notes',
            icon: 'plugin',
            activation: 'onApp',
            surface: { kind: 'sandboxed-web', entry: './web/index.html' }
          },
          {
            id: 'acme.notes.project',
            title: 'Project Notes',
            icon: 'files',
            activation: 'onProject',
            surface: { kind: 'sandboxed-web', entry: './web/index.html' }
          },
          {
            id: 'acme.notes.default',
            title: 'Default Notes',
            icon: 'flask',
            surface: { kind: 'sandboxed-web', entry: './web/index.html' }
          }
        ]
      }
    })

    const result = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: [
        { path: root, source: 'user-directory', scope: 'user', hasExecutablePiResources: false }
      ]
    })

    expect(result.plugins[0]?.workbench.map((entry) => entry.contribution.activation)).toEqual([
      'onApp',
      'onProject',
      'onProject'
    ])
  })

  it('accepts manifest.json style views, commands and a main entry', async () => {
    const root = await temporaryPluginRoot()
    await writeFile(join(root, 'main.js'), 'module.exports = {}')
    await writeManifest(root, {
      main: 'main.js',
      permissions: ['ui.view', 'notify', 'net.websocket'],
      contributes: {
        views: [
          { id: 'later', title: 'Later', entry: 'web/index.html', order: 20 },
          {
            id: 'changes',
            title: { en: 'Changes', 'zh-CN': '改动' },
            icon: 'diff',
            entry: 'web/index.html',
            order: 10
          }
        ],
        commands: [{ id: 'open', title: { en: 'Open' }, keywords: ['notes'] }]
      }
    })
    const canonicalRoot = await realpath(root)
    const result = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: [
        { path: root, source: 'user-directory', scope: 'user', hasExecutablePiResources: false }
      ]
    })
    expect(result.diagnostics).toEqual([])
    const [plugin] = result.plugins
    expect(plugin.canonicalMainPath).toBe(join(canonicalRoot, 'main.js'))
    expect(plugin.commands).toEqual([{ id: 'open', title: 'Open', keywords: ['notes'] }])
    expect(plugin.requestedPermissions).toEqual(['ui.view', 'notify', 'net.websocket'])
    expect(
      plugin.workbench.map(({ contribution }) => [
        contribution.viewId,
        contribution.title,
        contribution.icon
      ])
    ).toEqual([
      ['acme.notes.changes', '改动', 'git-review'],
      ['acme.notes.later', 'Later', 'plugin']
    ])
  })

  it('rejects a main entry outside the plugin root', async () => {
    const root = await temporaryPluginRoot()
    await writeManifest(root, { main: '../main.js' })
    const result = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: [
        { path: root, source: 'user-directory', scope: 'user', hasExecutablePiResources: false }
      ]
    })
    expect(result.plugins).toEqual([])
    expect(result.diagnostics.map(({ code }) => code)).toEqual(['main-invalid'])
  })

  it('accepts manifests without workbench contributions', async () => {
    const noContributesRoot = await temporaryPluginRoot('no-contributes')
    await writeManifest(noContributesRoot, {
      id: 'acme.no-contributes',
      contributes: undefined
    })
    const noWorkbenchRoot = await temporaryPluginRoot('no-workbench')
    await writeManifest(noWorkbenchRoot, {
      id: 'acme.no-workbench',
      contributes: {}
    })

    const result = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: [
        {
          path: noContributesRoot,
          source: 'no-contributes',
          scope: 'user',
          hasExecutablePiResources: true
        },
        {
          path: noWorkbenchRoot,
          source: 'no-workbench',
          scope: 'project',
          hasExecutablePiResources: true
        }
      ]
    })

    expect(result.diagnostics).toEqual([])
    expect(
      result.plugins
        .map(({ pluginId, workbench }) => ({ pluginId, workbench }))
        .sort((left, right) => left.pluginId.localeCompare(right.pluginId))
    ).toEqual([
      { pluginId: 'acme.no-contributes', workbench: [] },
      { pluginId: 'acme.no-workbench', workbench: [] }
    ])
  })

  it('accepts a safe relative entry without a dot-slash prefix', async () => {
    const root = await temporaryPluginRoot('bare-relative')
    await writeManifest(root, {
      id: 'acme.bare-relative',
      contributes: {
        workbench: [
          {
            id: 'acme.bare-relative.panel',
            title: 'Bare Relative',
            icon: 'plugin',
            surface: { kind: 'sandboxed-web', entry: 'web/index.html' }
          }
        ]
      }
    })

    const result = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: [
        {
          path: root,
          source: 'bare-relative',
          scope: 'user',
          hasExecutablePiResources: false
        }
      ]
    })

    expect(result.diagnostics).toEqual([])
    expect(result.plugins[0]?.workbench[0]?.canonicalEntryPath).toBe(
      join(await realpath(root), 'web', 'index.html')
    )
  })

  it('reports an invalid activation without throwing or loading the plugin', async () => {
    const root = await temporaryPluginRoot()
    await writeManifest(root, {
      contributes: {
        workbench: [
          {
            id: 'acme.notes.panel',
            title: 'Notes',
            icon: 'plugin',
            activation: 'onStartup',
            surface: { kind: 'sandboxed-web', entry: './web/index.html' }
          }
        ]
      }
    })

    const result = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: [
        { path: root, source: 'user-directory', scope: 'user', hasExecutablePiResources: false }
      ]
    })

    expect(result.plugins).toEqual([])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'manifest-invalid',
        pluginId: 'acme.notes'
      })
    ])
  })

  it('fails closed for invalid schema, compatibility, identifiers, icons, and commands', async () => {
    const invalidCases: Array<{
      name: string
      overrides: Record<string, unknown>
      code: string
    }> = [
      { name: 'schema', overrides: { schemaVersion: 2 }, code: 'manifest-invalid' },
      { name: 'version', overrides: { version: 'latest' }, code: 'manifest-invalid' },
      {
        name: 'invalid-engine',
        overrides: { engines: { piDesktop: 'not a range' } },
        code: 'engine-invalid'
      },
      {
        name: 'incompatible-engine',
        overrides: { engines: { piDesktop: '>=2.0.0' } },
        code: 'engine-incompatible'
      },
      { name: 'plugin-id', overrides: { id: 'notes' }, code: 'manifest-invalid' },
      {
        name: 'view-id',
        overrides: {
          contributes: {
            workbench: [
              {
                id: 'panel',
                title: 'Notes',
                icon: 'plugin',
                surface: { kind: 'sandboxed-web', entry: './web/index.html' }
              }
            ]
          }
        },
        code: 'manifest-invalid'
      },
      {
        name: 'icon',
        overrides: {
          contributes: {
            workbench: [
              {
                id: 'acme.notes.panel',
                title: 'Notes',
                icon: 'arbitrary-icon',
                surface: { kind: 'sandboxed-web', entry: './web/index.html' }
              }
            ]
          }
        },
        code: 'manifest-invalid'
      },
      {
        name: 'unsupported-surface',
        overrides: {
          contributes: {
            workbench: [
              {
                id: 'acme.notes.panel',
                title: 'Notes',
                icon: 'plugin',
                surface: { kind: 'native-view', entry: './web/index.html' }
              }
            ]
          }
        },
        code: 'manifest-invalid'
      },
      {
        name: 'commands',
        overrides: { commands: [{ id: 'acme.notes.run', title: 'Run' }] },
        code: 'commands-not-supported'
      },
      {
        name: 'contributes-commands-without-main',
        overrides: {
          contributes: {
            workbench: [],
            commands: [{ id: 'run', title: 'Run' }]
          }
        },
        code: 'manifest-invalid'
      }
    ]

    const roots = await Promise.all(
      invalidCases.map(async ({ name, overrides }) => {
        const root = await temporaryPluginRoot(name)
        await writeManifest(root, overrides)
        return {
          path: root,
          source: `case-${name}`,
          scope: 'user' as const,
          hasExecutablePiResources: false
        }
      })
    )

    const result = await discoverWorkbenchManifests({ appVersion: '0.1.0', roots })

    expect(result.plugins).toEqual([])
    expect(result.diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual(
      invalidCases.map(({ code }) => code).sort()
    )
  })

  it('rejects remote, absolute, traversal, escaping, missing, and non-file entries', async () => {
    const roots = await Promise.all(
      ['remote', 'absolute', 'traversal', 'symlink', 'missing', 'directory'].map(async (name) => {
        const root = await temporaryPluginRoot(name)
        const outside = join(root, '..', `${name}-outside.html`)
        await writeFile(outside, '<!doctype html><title>Outside</title>')

        if (name === 'symlink') await symlink(outside, join(root, 'web', 'escape.html'))
        const entries: Record<string, string> = {
          remote: 'https://example.com/plugin.html',
          absolute: outside,
          traversal: `web/../../${name}-outside.html`,
          symlink: './web/escape.html',
          missing: './web/missing.html',
          directory: './web'
        }
        await writeManifest(root, {
          id: `acme.${name}`,
          contributes: {
            workbench: [
              {
                id: `acme.${name}.panel`,
                title: 'Notes',
                icon: 'plugin',
                surface: { kind: 'sandboxed-web', entry: entries[name] }
              }
            ]
          }
        })
        return {
          path: root,
          source: `case-${name}`,
          scope: 'user' as const,
          hasExecutablePiResources: false
        }
      })
    )

    const result = await discoverWorkbenchManifests({ appVersion: '0.1.0', roots })

    expect(result.plugins).toEqual([])
    expect(result.diagnostics).toHaveLength(roots.length)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining(
        roots.map((_, index) =>
          expect.objectContaining({
            severity: 'error',
            code: 'entry-invalid',
            pluginId: `acme.${['remote', 'absolute', 'traversal', 'symlink', 'missing', 'directory'][index]}`
          })
        )
      )
    )
  })

  it('rejects duplicate plugin and view ids in deterministic root order', async () => {
    const pluginRoots = await Promise.all(
      ['duplicate-b', 'duplicate-a'].map(async (name) => {
        const root = await temporaryPluginRoot(name)
        await writeManifest(root, { name })
        return {
          path: root,
          source: name,
          scope: 'user' as const,
          hasExecutablePiResources: false
        }
      })
    )
    const orderedPluginRoots = [...pluginRoots].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    )

    const pluginDuplicates = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: pluginRoots
    })
    const pluginDuplicatesReversed = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: [...pluginRoots].reverse()
    })

    expect(pluginDuplicates).toEqual(pluginDuplicatesReversed)
    expect(pluginDuplicates.plugins.map((plugin) => plugin.source)).toEqual([
      orderedPluginRoots[0].source
    ])
    expect(pluginDuplicates.diagnostics).toEqual([
      expect.objectContaining({ code: 'duplicate-plugin-id', pluginId: 'acme.notes' })
    ])

    const viewRoots = await Promise.all(
      ['view-b', 'view-a'].map(async (name, index) => {
        const root = await temporaryPluginRoot(name)
        await writeManifest(root, {
          id: `acme.plugin${index}`,
          name,
          contributes: {
            workbench: [
              {
                id: 'acme.shared.panel',
                title: name,
                icon: 'plugin',
                surface: { kind: 'sandboxed-web', entry: './web/index.html' }
              }
            ]
          }
        })
        return {
          path: root,
          source: name,
          scope: 'project' as const,
          hasExecutablePiResources: false
        }
      })
    )

    const viewDuplicates = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: viewRoots
    })

    expect(viewDuplicates.plugins).toHaveLength(1)
    expect(viewDuplicates.diagnostics).toEqual([
      expect.objectContaining({ code: 'duplicate-view-id', viewId: 'acme.shared.panel' })
    ])
  })

  it('reports malformed manifests and unavailable roots without aborting discovery', async () => {
    const validRoot = await temporaryPluginRoot('valid')
    await writeManifest(validRoot, { id: 'acme.valid', name: 'Valid' })
    const malformedRoot = await temporaryPluginRoot('malformed')
    await writeFile(join(malformedRoot, 'pi-desktop.json'), '{ "schemaVersion": 1,')
    const manifestDirectoryRoot = await temporaryPluginRoot('manifest-directory')
    await mkdir(join(manifestDirectoryRoot, 'pi-desktop.json'))
    const missingRoot = join(malformedRoot, '..', 'missing-root')

    const result = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: [
        {
          path: malformedRoot,
          source: 'malformed',
          scope: 'user',
          hasExecutablePiResources: false
        },
        {
          path: validRoot,
          source: 'valid',
          scope: 'project',
          hasExecutablePiResources: false
        },
        {
          path: manifestDirectoryRoot,
          source: 'manifest-directory',
          scope: 'user',
          hasExecutablePiResources: false
        },
        {
          path: missingRoot,
          source: 'missing',
          scope: 'user',
          hasExecutablePiResources: false
        }
      ]
    })

    expect(result.plugins.map((plugin) => plugin.pluginId)).toEqual(['acme.valid'])
    expect(result.diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual([
      'manifest-invalid-json',
      'manifest-read-failed',
      'root-unavailable'
    ])
    expect(JSON.stringify(result.diagnostics)).not.toContain(malformedRoot)
  })

  it('accepts a 256 KiB manifest and rejects one additional byte', async () => {
    const maximumBytes = 256 * 1024
    const boundaryRoot = await temporaryPluginRoot('manifest-boundary')
    await writeManifest(boundaryRoot, {
      id: 'acme.manifest-boundary',
      contributes: undefined
    })
    await padManifestToBytes(boundaryRoot, maximumBytes)
    const oversizedRoot = await temporaryPluginRoot('manifest-oversized')
    await writeManifest(oversizedRoot, {
      id: 'acme.manifest-oversized',
      contributes: undefined
    })
    await padManifestToBytes(oversizedRoot, maximumBytes + 1)

    const result = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: [
        {
          path: oversizedRoot,
          source: 'manifest-oversized',
          scope: 'user',
          hasExecutablePiResources: false
        },
        {
          path: boundaryRoot,
          source: 'manifest-boundary',
          scope: 'user',
          hasExecutablePiResources: false
        }
      ]
    })

    expect(result.plugins.map((plugin) => plugin.pluginId)).toEqual(['acme.manifest-boundary'])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'manifest-too-large'
      })
    ])
    expect(JSON.stringify(result.diagnostics)).not.toContain(oversizedRoot)
  })

  it('ignores an absent manifest but reports a broken manifest symlink', async () => {
    const absentRoot = await temporaryPluginRoot('manifest-absent')
    const brokenRoot = await temporaryPluginRoot('manifest-broken-link')
    await symlink(
      join(brokenRoot, 'missing-manifest-target.json'),
      join(brokenRoot, 'pi-desktop.json')
    )

    const result = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: [
        {
          path: absentRoot,
          source: 'manifest-absent',
          scope: 'user',
          hasExecutablePiResources: true
        },
        {
          path: brokenRoot,
          source: 'manifest-broken-link',
          scope: 'user',
          hasExecutablePiResources: true
        }
      ]
    })

    expect(result.plugins).toEqual([])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'manifest-read-failed' })
    ])
    expect(JSON.stringify(result.diagnostics)).not.toContain(brokenRoot)
  })

  it('canonicalizes root and in-root manifest symlinks but rejects a manifest escape', async () => {
    const canonicalRoot = await temporaryPluginRoot('canonical')
    await writeManifest(canonicalRoot, { id: 'acme.canonical' })
    const canonicalManifest = join(canonicalRoot, 'manifest.actual.json')
    await rename(join(canonicalRoot, 'pi-desktop.json'), canonicalManifest)
    await symlink(canonicalManifest, join(canonicalRoot, 'pi-desktop.json'))
    const rootAlias = join(canonicalRoot, '..', 'canonical-alias')
    await symlink(canonicalRoot, rootAlias)

    const escapeRoot = await temporaryPluginRoot('manifest-escape')
    await writeManifest(escapeRoot, { id: 'acme.manifest-escape' })
    const outsideManifest = join(escapeRoot, '..', 'outside-pi-desktop.json')
    await rename(join(escapeRoot, 'pi-desktop.json'), outsideManifest)
    await symlink(outsideManifest, join(escapeRoot, 'pi-desktop.json'))

    const result = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: [
        {
          path: rootAlias,
          source: 'root-alias',
          scope: 'user',
          hasExecutablePiResources: false
        },
        {
          path: escapeRoot,
          source: 'manifest-escape',
          scope: 'project',
          hasExecutablePiResources: false
        }
      ]
    })

    expect(result.plugins).toEqual([
      expect.objectContaining({
        pluginId: 'acme.canonical',
        canonicalRootPath: await realpath(canonicalRoot),
        manifestPath: await realpath(canonicalManifest),
        workbench: [
          expect.objectContaining({
            canonicalEntryPath: join(await realpath(canonicalRoot), 'web', 'index.html')
          })
        ]
      })
    ])
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'manifest-read-failed' })])
  })

  it('lets a bundled plugin keep its id against a user plugin that sorts earlier', async () => {
    const user = await temporaryPluginRoot('a-user')
    await writeManifest(user, { name: 'Impostor' })
    const bundled = await temporaryPluginRoot('z-bundled')
    await writeManifest(bundled, { name: 'Shipped' })
    const discovery = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: [
        { path: user, source: '本机插件', scope: 'user', hasExecutablePiResources: false },
        { path: bundled, source: '内置插件', scope: 'bundled', hasExecutablePiResources: false }
      ]
    })
    expect(discovery.plugins.map(({ name, scope }) => `${name}:${scope}`)).toEqual([
      'Shipped:bundled'
    ])
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({ code: 'duplicate-plugin-id', pluginId: 'acme.notes' })
    ])
  })

  it('validates agent tools, skills and MCP servers, expanding the plugin root', async () => {
    const root = await temporaryPluginRoot()
    const canonicalRoot = await realpath(root)
    await mkdir(join(root, 'skills', 'review'), { recursive: true })
    await writeFile(join(root, 'main.js'), 'module.exports = {}')
    await writeManifest(root, {
      main: 'main.js',
      permissions: ['agent.tools', 'agent.skills', 'mcp.local'],
      contributes: {
        agentTools: [
          {
            name: 'lookup',
            title: { en: 'Lookup', 'zh-CN': '查询' },
            description: 'Look something up',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
            readOnly: true
          },
          { name: 'save', description: 'Save a note' }
        ],
        skills: ['skills'],
        mcpServers: {
          notes: {
            command: 'node',
            args: ['${pluginRoot}/server.js'],
            env: { ROOT: '${pluginRoot}' }
          }
        }
      }
    })
    const { plugins, diagnostics } = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: [{ path: root, source: 'test', scope: 'user', hasExecutablePiResources: false }]
    })
    expect(diagnostics).toEqual([])
    expect(plugins[0].agentTools).toEqual([
      {
        name: 'lookup',
        title: '查询',
        description: 'Look something up',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        readOnly: true
      },
      {
        name: 'save',
        title: 'save',
        description: 'Save a note',
        parameters: { type: 'object', properties: {} },
        readOnly: false
      }
    ])
    expect(plugins[0].skillPaths).toEqual([join(canonicalRoot, 'skills')])
    expect(plugins[0].mcpServers).toEqual({
      notes: {
        command: 'node',
        args: [`${canonicalRoot}/server.js`],
        env: { ROOT: canonicalRoot }
      }
    })
  })

  it('rejects agent tools without main and skills outside the plugin', async () => {
    const withoutMain = await temporaryPluginRoot('no-main')
    await writeManifest(withoutMain, {
      contributes: { agentTools: [{ name: 'lookup', description: 'x' }] }
    })
    const outside = await temporaryPluginRoot('outside')
    await writeManifest(outside, { id: 'acme.outside', contributes: { skills: ['../'] } })
    const { plugins, diagnostics } = await discoverWorkbenchManifests({
      appVersion: '0.1.0',
      roots: [withoutMain, outside].map((path) => ({
        path,
        source: 'test',
        scope: 'user' as const,
        hasExecutablePiResources: false
      }))
    })
    expect(plugins).toEqual([])
    expect(diagnostics.map(({ code }) => code).sort()).toEqual([
      'manifest-invalid',
      'skill-invalid'
    ])
  })
})
