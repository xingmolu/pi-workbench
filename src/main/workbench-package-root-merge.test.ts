import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectLoadedPiPackageRoots } from '../agent-host/pi-package-roots'
import type { PiPackageRoot } from '../shared/workbench-host-contracts'
import { createWorkbenchHostState } from './workbench-host-state'
import { discoverWorkbenchManifests } from './workbench-manifest'
import { mergeWorkbenchPackageRoots } from './workbench-package-root-merge'

const temporaryDirectories: string[] = []

async function createPluginRoot(): Promise<{ parent: string; root: string; alias: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'workbench-root-merge-'))
  temporaryDirectories.push(parent)
  const root = join(parent, 'plugin-root')
  const alias = join(parent, 'plugin-alias')
  await mkdir(join(root, 'web'), { recursive: true })
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><title>Safe plugin</title>')
  await writeFile(
    join(root, 'pi-desktop.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'example.safe-plugin',
      version: '1.0.0',
      name: 'Safe plugin',
      engines: { piDesktop: '^0.1.0' },
      contributes: {
        workbench: [
          {
            id: 'example.safe-plugin.panel',
            title: 'Safe plugin',
            icon: 'plugin',
            activation: 'onApp',
            surface: { kind: 'sandboxed-web', entry: './web/index.html' }
          }
        ]
      }
    })
  )
  await symlink(root, alias, 'dir')
  return { parent, root, alias }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('mergeWorkbenchPackageRoots', () => {
  it('canonicalizes aliases before discovery and preserves the executable-resource warning', async () => {
    const { root, alias } = await createPluginRoot()
    const roots: PiPackageRoot[] = [
      {
        path: root,
        source: '本机插件',
        scope: 'user',
        hasExecutablePiResources: false
      },
      {
        path: alias,
        source: 'Pi 用户包',
        scope: 'user',
        hasExecutablePiResources: true
      }
    ]

    const merged = await mergeWorkbenchPackageRoots(roots)
    expect(merged).toEqual([
      {
        path: await realpath(root),
        source: '本机插件 / Pi 用户包',
        scope: 'user',
        hasExecutablePiResources: true
      }
    ])

    const discovery = await discoverWorkbenchManifests({ roots: merged, appVersion: '0.1.0' })
    expect(discovery.plugins).toHaveLength(1)
    expect(discovery.plugins[0]).toMatchObject({
      pluginId: 'example.safe-plugin',
      hasExecutablePiResources: true,
      source: '本机插件 / Pi 用户包'
    })
    expect(discovery.diagnostics.map(({ code }) => code)).not.toContain('duplicate-plugin-id')
  })

  it('prefers project scope and only aggregates allowlisted source labels', async () => {
    const { root, alias } = await createPluginRoot()
    const merged = await mergeWorkbenchPackageRoots([
      {
        path: root,
        source: 'https://user:token@host/repo?auth=secret#fragment',
        scope: 'user',
        hasExecutablePiResources: false
      },
      {
        path: alias,
        source: 'Pi 项目包',
        scope: 'project',
        hasExecutablePiResources: true
      }
    ])

    expect(merged).toEqual([
      {
        path: await realpath(root),
        source: 'Pi 项目包 / 来源已隐藏',
        scope: 'project',
        hasExecutablePiResources: true
      }
    ])
    expect(JSON.stringify(merged.map(({ source }) => source))).not.toMatch(
      /user:token|auth=|secret|fragment/
    )
  })

  it('retains an unavailable root for a safe discovery diagnostic', async () => {
    await expect(
      mergeWorkbenchPackageRoots(
        [
          {
            path: '/missing/plugin-root',
            source: '/Users/private/package-source',
            scope: 'user',
            hasExecutablePiResources: false
          }
        ],
        {
          canonicalize: async () => {
            throw new Error('missing')
          }
        }
      )
    ).resolves.toEqual([
      {
        path: '/missing/plugin-root',
        source: '来源已隐藏',
        scope: 'user',
        hasExecutablePiResources: false
      }
    ])
  })

  it('keeps canonical paths and loader secrets out of renderer snapshots and diagnostics', async () => {
    const { parent, root, alias } = await createPluginRoot()
    const invalidRoot = join(parent, 'invalid-plugin-root')
    await mkdir(invalidRoot)
    await writeFile(join(invalidRoot, 'pi-desktop.json'), '{not-json')
    const credentialSource = 'https://user:token@host/repo.git?auth=very-secret#private'
    const localSource = '/Users/private/.pi/packages/invalid-plugin/extension.ts'
    const packageRoots = await collectLoadedPiPackageRoots({
      extensions: [
        {
          sourceInfo: {
            path: join(alias, 'extension.ts'),
            source: credentialSource,
            scope: 'user',
            origin: 'package',
            baseDir: alias
          }
        },
        {
          sourceInfo: {
            path: join(invalidRoot, 'extension.ts'),
            source: localSource,
            scope: 'user',
            origin: 'package',
            baseDir: invalidRoot
          }
        }
      ],
      skills: []
    })
    const state = createWorkbenchHostState({
      appVersion: '0.1.0',
      userRoots: async () => [
        {
          path: root,
          source: '本机插件',
          scope: 'user',
          hasExecutablePiResources: false
        }
      ],
      discover: discoverWorkbenchManifests,
      store: { get: () => undefined, set: () => undefined },
      createView: async () => {
        throw new Error('view creation is not part of registry discovery')
      },
      nativeViews: { browser: { setView: () => undefined } }
    })

    await state.setPackageRoots(packageRoots)
    const snapshot = state.snapshot()
    const rendererPayload = JSON.stringify(snapshot)
    expect(
      snapshot.plugins.find(({ pluginId }) => pluginId === 'example.safe-plugin')
    ).toMatchObject({
      source: '本机插件 / Pi 用户包',
      hasExecutablePiResources: true
    })
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({
        code: 'manifest-invalid-json',
        message: expect.stringContaining('Pi 用户包')
      })
    ])
    expect(rendererPayload).not.toContain(await realpath(root))
    expect(rendererPayload).not.toContain(await realpath(invalidRoot))
    expect(rendererPayload).not.toContain(alias)
    expect(rendererPayload).not.toMatch(/user:token|auth=|very-secret|#private|\/Users\/private/)
    state.dispose()
  })
})
