import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitReviewProcess } from './git-review-process'
import {
  createUserGitPushRunner,
  PluginFileService,
  PluginGitService,
  resolveInProject
} from './plugin-services'
import { NULL_DEVICE, systemGit } from './system-git'

const GIT = systemGit()

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
  execFileSync(GIT.path, args, {
    cwd: project,
    env: {
      ...GIT.env,
      HOME: root,
      GIT_CONFIG_GLOBAL: NULL_DEVICE,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com'
    }
  }).toString()

function gitService(): PluginGitService {
  return new PluginGitService(
    new GitReviewProcess({
      gitPath: GIT.path,
      hooksPath: join(root, 'hooks'),
      trustedEnv: { HOME: root, ...GIT.env, LC_ALL: 'C' }
    }),
    async () => ({ name: 'Plugin User', email: 'user@example.com' }),
    createUserGitPushRunner({
      gitPath: GIT.path,
      hooksPath: join(root, 'hooks'),
      env: {
        HOME: root,
        ...GIT.env,
        GIT_DIR: '/elsewhere',
        GIT_CONFIG_GLOBAL: NULL_DEVICE
      }
    })
  )
}

describe('plugin file service', () => {
  it('keeps every path inside the real project, including through symlinks', async () => {
    mkdirSync(join(root, 'outside'))
    symlinkSync(join(root, 'outside'), join(project, 'link'))
    await expect(resolveInProject(project, 'src/a.ts')).resolves.toMatch(
      /project[\\/]src[\\/]a\.ts$/
    )
    await expect(resolveInProject(project, 'new/deep/file.ts')).resolves.toMatch(
      /new[\\/]deep[\\/]file\.ts$/
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

  describe('push', () => {
    const remote = (): string => join(root, 'remote.git')
    const setupRepository = (): void => {
      execFileSync(GIT.path, ['init', '-q', '--bare', remote()])
      git('init', '-q', '-b', 'main')
      writeFileSync(join(project, 'a.txt'), 'a\n')
      git('add', '.')
      git('commit', '-q', '-m', 'first')
      git('remote', 'add', 'origin', remote())
    }
    const remoteHead = (branch: string): string =>
      execFileSync(GIT.path, ['--git-dir', remote(), 'rev-parse', branch]).toString().trim()

    it('plans a first push to origin, pushes the approved commit and sets the upstream', async () => {
      setupRepository()
      writeFileSync(
        join(project, '.git', 'hooks', 'pre-push'),
        '#!/bin/sh\ntouch hook-ran\nexit 1\n',
        {
          mode: 0o755
        }
      )
      const service = gitService()
      const plan = await service.pushPlan(project)
      expect(plan).toMatchObject({
        branch: 'main',
        remote: 'origin',
        remoteBranch: 'main',
        setUpstream: true,
        commits: [{ subject: 'first' }],
        moreCommits: 0
      })
      await expect(service.push(plan)).resolves.toEqual({ remote: 'origin', branch: 'main' })
      expect(remoteHead('main')).toBe(plan.head)
      expect(git('config', 'branch.main.merge').trim()).toBe('refs/heads/main')
      expect(await service.status(project)).toMatchObject({ upstream: 'origin/main', ahead: 0 })
      expect(() => readFileSync(join(project, 'hook-ran'))).toThrow()

      writeFileSync(join(project, 'a.txt'), 'b\n')
      git('commit', '-q', '-am', 'second')
      const next = await service.pushPlan(project)
      expect(next).toMatchObject({ setUpstream: false, commits: [{ subject: 'second' }] })
      await service.push(next)
      expect(remoteHead('main')).toBe(next.head)
      await expect(service.pushPlan(project)).rejects.toMatchObject({ code: 'CONFLICT' })
    })

    it('refuses to push something other than what was approved', async () => {
      setupRepository()
      const service = gitService()
      const plan = await service.pushPlan(project)
      git('commit', '-q', '--allow-empty', '-m', 'sneaky')
      await expect(service.push(plan)).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(() => remoteHead('main')).toThrow()
    })

    it('reports a rejected non-fast-forward push as a conflict', async () => {
      setupRepository()
      const service = gitService()
      await service.push(await service.pushPlan(project))
      git('commit', '-q', '--amend', '--allow-empty', '-m', 'rewritten')
      await expect(service.push(await service.pushPlan(project))).rejects.toMatchObject({
        code: 'CONFLICT',
        message: expect.stringContaining('拉取')
      })
    })

    it('refuses repositories whose local config could run a program during push', async () => {
      setupRepository()
      git('config', 'core.sshCommand', 'touch pwned')
      await expect(gitService().pushPlan(project)).rejects.toMatchObject({ code: 'UNSUPPORTED' })
      git('config', '--unset', 'core.sshCommand')
      git('config', 'remote.origin.receivepack', 'touch pwned; git-receive-pack')
      await expect(gitService().pushPlan(project)).rejects.toMatchObject({ code: 'UNSUPPORTED' })
      git('config', '--unset', 'remote.origin.receivepack')
      writeFileSync(join(root, 'extra.config'), '[core]\n\tsshCommand = touch pwned\n')
      git('config', 'include.path', join(root, 'extra.config'))
      await expect(gitService().pushPlan(project)).rejects.toMatchObject({
        code: 'UNSUPPORTED',
        message: expect.stringContaining('include.path')
      })
    })

    it('needs a branch and a remote', async () => {
      git('init', '-q', '-b', 'main')
      git('commit', '-q', '--allow-empty', '-m', 'first')
      await expect(gitService().pushPlan(project)).rejects.toMatchObject({ code: 'NOT_FOUND' })
      git('checkout', '-q', '--detach')
      await expect(gitService().pushPlan(project)).rejects.toMatchObject({ code: 'CONFLICT' })
    })

    it('hides credentials embedded in the remote address', async () => {
      setupRepository()
      git('remote', 'set-url', 'origin', 'https://user:secret@example.com/repo.git')
      const plan = await gitService().pushPlan(project)
      expect(plan.url).toBe('https://example.com/repo.git')
    })
  })
})
