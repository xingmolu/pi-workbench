import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitReviewProcess } from './git-review-process'
import { PluginFileService, PluginGitService, resolveInProject } from './plugin-services'

let root: string
let project: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-plugin-services-'))
  project = join(root, 'project')
  mkdirSync(join(project, 'src'), { recursive: true })
  mkdirSync(join(root, 'hooks'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const git = (...args: string[]): string =>
  execFileSync('/usr/bin/git', args, {
    cwd: project,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: root,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com'
    }
  }).toString()

function gitService(): PluginGitService {
  return new PluginGitService(
    new GitReviewProcess({
      gitPath: '/usr/bin/git',
      hooksPath: join(root, 'hooks'),
      trustedEnv: { HOME: root, PATH: '/usr/bin:/bin', LC_ALL: 'C' }
    }),
    async () => ({ name: 'Plugin User', email: 'user@example.com' })
  )
}

describe('plugin file service', () => {
  it('keeps every path inside the real project, including through symlinks', async () => {
    mkdirSync(join(root, 'outside'))
    symlinkSync(join(root, 'outside'), join(project, 'link'))
    await expect(resolveInProject(project, 'src/a.ts')).resolves.toMatch(/project\/src\/a\.ts$/)
    await expect(resolveInProject(project, 'new/deep/file.ts')).resolves.toMatch(
      /new\/deep\/file\.ts$/
    )
    await expect(resolveInProject(project, '../x')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED'
    })
    await expect(resolveInProject(project, 'link/a.ts')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED'
    })
  })

  it('lists, stats, reads UTF-8 text and writes inside the project', async () => {
    const fs = new PluginFileService()
    writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(project, 'bin.dat'), Buffer.from([0, 1, 2]))
    const listing = await fs.list(project, '.')
    expect(listing.entries.map(({ name, kind }) => `${kind}:${name}`)).toEqual([
      'directory:src',
      'file:bin.dat'
    ])
    await expect(fs.readText(project, 'src/a.ts')).resolves.toEqual({
      text: 'export const a = 1\n'
    })
    await expect(fs.readText(project, 'bin.dat')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
    await expect(fs.readText(project, 'missing.ts')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(fs.stat(project, 'src')).resolves.toMatchObject({ kind: 'directory' })
    await fs.writeText(project, 'docs/notes.md', '# hi\n')
    expect(readFileSync(join(project, 'docs', 'notes.md'), 'utf8')).toBe('# hi\n')
    await expect(fs.writeText(project, 'src', 'x')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
  })
})

describe('plugin git service', () => {
  it('reports status, diffs, stages, commits and discards through the hardened runner', async () => {
    git('init', '-q', '-b', 'main')
    writeFileSync(join(project, 'src', 'a.ts'), 'one\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    const service = gitService()

    writeFileSync(join(project, 'src', 'a.ts'), 'two\n')
    writeFileSync(join(project, 'b.ts'), 'new\n')
    const status = await service.status(project)
    expect(status.branch).toBe('main')
    expect(status.files).toEqual(
      expect.arrayContaining([
        { index: ' ', worktree: 'M', path: 'src/a.ts' },
        { index: '?', worktree: '?', path: 'b.ts' }
      ])
    )
    expect((await service.diff(project, 'src/a.ts', false)).patch).toContain('+two')

    await service.stage(project, ['src/a.ts', 'b.ts'])
    expect((await service.diff(project, undefined, true)).patch).toContain('+new')
    await service.unstage(project, ['b.ts'])
    const { hash } = await service.commit(project, 'update a')
    expect(hash).toMatch(/^[0-9a-f]{40}$/)
    expect((await service.log(project, 5)).commits.map(({ subject }) => subject)).toEqual([
      'update a',
      'init'
    ])
    expect(git('log', '-1', '--format=%an <%ae>').trim()).toBe('Plugin User <user@example.com>')

    writeFileSync(join(project, 'src', 'a.ts'), 'three\n')
    await service.discard(project, ['src/a.ts'])
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('two\n')
  })

  it('refuses repositories whose filters would run during staging', async () => {
    git('init', '-q')
    git('config', 'filter.evil.clean', 'touch pwned')
    await expect(gitService().status(project)).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })

  it('does not run repository hooks on commit', async () => {
    git('init', '-q')
    writeFileSync(join(project, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ntouch hook-ran\n', {
      mode: 0o755
    })
    writeFileSync(join(project, 'a.txt'), 'a\n')
    const service = gitService()
    await service.stage(project, ['a.txt'])
    await service.commit(project, 'first')
    expect(() => readFileSync(join(project, 'hook-ran'))).toThrow()
  })

  it('reports a non-repository clearly', async () => {
    await expect(gitService().status(project)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
