import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pathToPersistAfterOpen, resolveExistingProjectPath } from './recent-project'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-desktop-recent-project-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('resolveExistingProjectPath', () => {
  it('accepts only a directory and returns its realpath', async () => {
    const root = await temporaryDirectory()
    const project = join(root, 'project')
    const alias = join(root, 'project-link')
    await mkdir(project)
    await symlink(project, alias)

    await expect(resolveExistingProjectPath(alias)).resolves.toBe(await realpath(project))
  })

  it('rejects missing paths, files, and invalid preference values', async () => {
    const root = await temporaryDirectory()
    const file = join(root, 'not-a-project.txt')
    await writeFile(file, 'not a directory')

    await expect(resolveExistingProjectPath(join(root, 'missing'))).resolves.toBeNull()
    await expect(resolveExistingProjectPath(file)).resolves.toBeNull()
    await expect(resolveExistingProjectPath('   ')).resolves.toBeNull()
    await expect(resolveExistingProjectPath(42)).resolves.toBeNull()
  })
})

describe('pathToPersistAfterOpen', () => {
  it('returns the canonical path only when the successful snapshot confirms it', () => {
    expect(
      pathToPersistAfterOpen('/real/project', {
        project: { path: '/real/project', name: 'project' }
      })
    ).toBe('/real/project')
    expect(
      pathToPersistAfterOpen('/real/project', { project: { path: '/other', name: 'other' } })
    ).toBeNull()
    expect(pathToPersistAfterOpen('/real/project', { project: null })).toBeNull()
  })
})
