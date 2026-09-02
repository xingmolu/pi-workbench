import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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

describe('discoverWorkbenchManifests', () => {
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
      { name: 'missing-engine', overrides: { engines: undefined }, code: 'manifest-invalid' },
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
        name: 'commands',
        overrides: { commands: [{ id: 'acme.notes.run', title: 'Run' }] },
        code: 'commands-not-supported'
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
          traversal: `../${name}-outside.html`,
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
})
