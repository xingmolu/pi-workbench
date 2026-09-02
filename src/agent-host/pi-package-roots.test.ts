import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectLoadedPiPackageRoots,
  packageRootsMessageForSnapshot,
  type LoadedPiResource
} from './pi-package-roots'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-package-roots-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

function resource(
  baseDir: string | undefined,
  options: {
    source: string
    scope: 'user' | 'project' | 'temporary'
    origin?: 'package' | 'top-level'
  }
): LoadedPiResource {
  return {
    sourceInfo: {
      path: baseDir ? join(baseDir, 'resource') : '/resource-without-package-root',
      source: options.source,
      scope: options.scope,
      origin: options.origin ?? 'package',
      ...(baseDir === undefined ? {} : { baseDir })
    }
  }
}

describe('collectLoadedPiPackageRoots', () => {
  it('canonicalizes, deduplicates, derives a safe scope label, and tracks extensions', async () => {
    const directory = await temporaryDirectory()
    const packageRoot = join(directory, 'package')
    const skillOnlyRoot = join(directory, 'skill-only')
    const aliasRoot = join(directory, 'package-alias')
    await mkdir(packageRoot)
    await mkdir(skillOnlyRoot)
    await symlink(packageRoot, aliasRoot, 'dir')

    const roots = await collectLoadedPiPackageRoots({
      extensions: [
        resource(aliasRoot, { source: 'z-extension-source', scope: 'user' }),
        resource(packageRoot, { source: 'a-extension-source', scope: 'project' })
      ],
      skills: [
        resource(packageRoot, { source: 'skill-source', scope: 'user' }),
        resource(skillOnlyRoot, { source: 'skill-only-source', scope: 'user' })
      ]
    })

    expect(roots).toEqual([
      {
        path: await realpath(packageRoot),
        source: 'Pi 项目包',
        scope: 'project',
        hasExecutablePiResources: true
      },
      {
        path: await realpath(skillOnlyRoot),
        source: 'Pi 用户包',
        scope: 'user',
        hasExecutablePiResources: false
      }
    ])
  })

  it('excludes non-package, temporary, relative, missing, and baseDir-less resources', async () => {
    const directory = await temporaryDirectory()
    const validRoot = join(directory, 'valid')
    await mkdir(validRoot)

    await expect(
      collectLoadedPiPackageRoots({
        extensions: [
          resource(validRoot, { source: 'top-level', scope: 'user', origin: 'top-level' }),
          resource(validRoot, { source: 'temporary', scope: 'temporary' }),
          resource('relative/package', { source: 'relative', scope: 'user' }),
          resource(join(directory, 'missing'), { source: 'missing', scope: 'project' }),
          resource(undefined, { source: 'missing-base', scope: 'user' })
        ],
        skills: [resource(validRoot, { source: 'valid', scope: 'user' })]
      })
    ).resolves.toEqual([
      {
        path: await realpath(validRoot),
        source: 'Pi 用户包',
        scope: 'user',
        hasExecutablePiResources: false
      }
    ])
  })

  it('derives renderer-safe labels without forwarding loader paths or credential URLs', async () => {
    const directory = await temporaryDirectory()
    const credentialRoot = join(directory, 'credential-package')
    const localRoot = join(directory, 'local-package')
    await mkdir(credentialRoot)
    await mkdir(localRoot)
    const credentialSource = 'https://user:token@host/repo.git?auth=very-secret#private'
    const localSource = '/Users/private/.pi/packages/local-package/extension.ts'

    const roots = await collectLoadedPiPackageRoots({
      extensions: [
        resource(credentialRoot, { source: credentialSource, scope: 'user' }),
        resource(localRoot, { source: localSource, scope: 'project' })
      ],
      skills: []
    })

    expect(roots.map(({ source }) => source)).toEqual(['Pi 用户包', 'Pi 项目包'])
    const labels = JSON.stringify(roots.map(({ source }) => source))
    expect(labels).not.toContain('user:token')
    expect(labels).not.toContain('auth=')
    expect(labels).not.toContain('very-secret')
    expect(labels).not.toContain('/Users/private')
    expect(labels).not.toContain('credential-package')
    expect(labels).not.toContain('local-package')
  })

  it('returns deterministic root ordering regardless of loader order', async () => {
    const directory = await temporaryDirectory()
    const alpha = join(directory, 'alpha')
    const omega = join(directory, 'omega')
    await mkdir(alpha)
    await mkdir(omega)

    const roots = await collectLoadedPiPackageRoots({
      extensions: [
        resource(omega, { source: 'omega', scope: 'user' }),
        resource(alpha, { source: 'alpha', scope: 'user' })
      ],
      skills: []
    })

    expect(roots.map((root) => root.path)).toEqual([await realpath(alpha), await realpath(omega)])
  })
})

describe('packageRootsMessageForSnapshot', () => {
  it('accepts only the publication bound to the current runtime and snapshot identity', () => {
    const currentRuntime = {}
    const publication = {
      runtime: currentRuntime,
      message: {
        type: 'desktop-plugin-roots' as const,
        sessionId: 'session-current',
        generation: 9,
        roots: []
      }
    }

    expect(
      packageRootsMessageForSnapshot(publication, {
        runtime: currentRuntime,
        sessionId: 'session-current',
        generation: 9
      })
    ).toBe(publication.message)
    expect(
      packageRootsMessageForSnapshot(publication, {
        runtime: {},
        sessionId: 'session-current',
        generation: 9
      })
    ).toBeNull()
    expect(
      packageRootsMessageForSnapshot(publication, {
        runtime: currentRuntime,
        sessionId: 'session-new',
        generation: 10
      })
    ).toBeNull()
  })
})
