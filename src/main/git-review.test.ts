import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitReview } from './git-review'
import type { GitProcessOptions } from './git-review-process'

const temporary: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporary.splice(0).map((path) => fs.rm(path, { recursive: true, force: true }))
  )
})
async function fixture(execute?: GitProcessOptions['spawn']) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pi-git-review-')))
  temporary.push(root)
  const project = join(root, 'project')
  const home = join(root, 'home')
  const hooks = join(root, 'hooks')
  await Promise.all([project, home, hooks].map((path) => fs.mkdir(path)))
  const env = { HOME: home, PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args: string[]): string =>
    execFileSync('/usr/bin/git', args, {
      cwd: project,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  const service = new GitReview({
    gitPath: '/usr/bin/git',
    hooksPath: hooks,
    trustedEnv: env,
    spawn: execute
  })
  service.setProject(project)
  const write = (path: string, value: string | Buffer) => fs.writeFile(join(project, path), value)
  const list = (view: 'unstaged' | 'staged' | 'branch', baseRef?: string) =>
    service.dispatch({ type: 'list', projectPath: project, view, ...(baseRef ? { baseRef } : {}) })
  return { root, project, home, hooks, git, service, write, list }
}

describe('project-bound Git Review', () => {
  it.each(['project', 'refresh'] as const)(
    'stops preview postprocessing after %s changes during lstat',
    async (change) => {
      let inventories = 0
      const f = await fixture((executable, args, options) =>
        args.includes('status')
          ? spawn(
              process.execPath,
              [
                '-e',
                `process.stdout.write(${JSON.stringify(inventories++ === 0 ? Array.from({ length: 8 }, (_, i) => `? missing${i}\0`).join('') : '')})`
              ],
              options
            )
          : spawn(executable, args, options)
      )
      const lstat = fs.lstat.bind(fs)
      let previews = 0
      let refreshed: ReturnType<typeof f.list> | undefined
      vi.spyOn(fs, 'lstat').mockImplementation(async (path) => {
        if (String(path).includes('/missing')) {
          if (++previews === 1) {
            if (change === 'project') f.service.setProject(null)
            else refreshed = f.list('unstaged')
          }
          return lstat(f.project)
        }
        return lstat(path)
      })
      expect(await f.list('unstaged')).toMatchObject({
        type: 'unavailable',
        reason: change === 'project' ? 'project-changed' : 'stale-review'
      })
      expect(previews).toBe(1)
      if (refreshed) expect(await refreshed).toMatchObject({ type: 'list', entries: [] })
    }
  )
  it('rejects an oversized inventory before issuing preview stats', async () => {
    const records = Array.from({ length: 5001 }, (_, i) => `? missing${i}\0`).join('')
    const f = await fixture((executable, args, options) =>
      args.includes('status')
        ? spawn(
            process.execPath,
            ['-e', `process.stdout.write(${JSON.stringify(records)})`],
            options
          )
        : spawn(executable, args, options)
    )
    const lstat = fs.lstat.bind(fs)
    const info = await lstat(f.project)
    let previews = 0
    vi.spyOn(fs, 'lstat').mockImplementation(async (path) => {
      if (String(path).includes('/missing')) {
        previews++
        return info
      }
      return lstat(path)
    })
    expect(await f.list('unstaged')).toMatchObject({ type: 'unavailable', reason: 'output-limit' })
    expect(previews).toBe(0)
  })
  it('accepts exactly 5,000 inventory entries without silently truncating', async () => {
    const records = Array.from({ length: 5000 }, (_, i) => `? nested${i}/\0`).join('')
    const f = await fixture((executable, args, options) =>
      args.includes('status')
        ? spawn(
            process.execPath,
            ['-e', `process.stdout.write(${JSON.stringify(records)})`],
            options
          )
        : spawn(executable, args, options)
    )
    const review = await f.list('unstaged')
    expect(review.type).toBe('list')
    if (review.type === 'list') expect(review.entries).toHaveLength(5000)
  })
  it.each([4999, 5000])(
    'enforces the postprocessing deadline at %i ms without swallowing timeout',
    async (elapsed) => {
      const f = await fixture()
      await f.write('file', 'new\n')
      const now = vi.spyOn(performance, 'now').mockReturnValue(0)
      const lstat = fs.lstat.bind(fs)
      let previews = 0
      vi.spyOn(fs, 'lstat').mockImplementation(async (path) => {
        if (String(path) === join(f.project, 'file')) {
          previews++
          now.mockReturnValue(elapsed)
        }
        return lstat(path)
      })
      expect(await f.list('unstaged')).toMatchObject(
        elapsed < 5000 ? { type: 'list' } : { type: 'unavailable', reason: 'timeout' }
      )
      expect(previews).toBe(1)
    }
  )
  it('compares index and worktree types after a staged gitlink-to-file replacement', async () => {
    const f = await fixture()
    await f.write('base', 'base\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'base')
    f.git(
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${f.git('rev-parse', 'HEAD').trim()},file`
    )
    f.git('commit', '-qm', 'gitlink')
    await f.write('file', 'indexed\n')
    f.git('update-index', '--force-remove', 'file')
    f.git('add', 'file')
    await f.write('file', 'working\n')
    const review = await f.list('unstaged')
    expect(review).toMatchObject({ type: 'list', entries: [{ path: 'file', kind: 'tracked' }] })
    if (review.type !== 'list') return
    expect(
      await f.service.dispatch({
        type: 'patch',
        projectPath: f.project,
        reviewId: review.reviewId,
        entryId: review.entries[0].entryId
      })
    ).toMatchObject({
      type: 'patch',
      kind: 'text',
      text: expect.stringContaining('-indexed\n+working\n')
    })
    await f.write('file', 'indexed\n')
    expect(
      await f.service.dispatch({
        type: 'patch',
        projectPath: f.project,
        reviewId: review.reviewId,
        entryId: review.entries[0].entryId
      })
    ).toMatchObject({ type: 'patch', kind: 'empty' })
  })
  it('rejects a formerly ordinary file capability when a merge introduces a conflict', async () => {
    const f = await fixture()
    await f.write('file', 'base\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'base')
    f.git('checkout', '-qb', 'other')
    await f.write('file', 'other\n')
    f.git('commit', '-qam', 'other')
    f.git('checkout', '-q', 'main')
    await f.write('file', 'main\n')
    f.git('commit', '-qam', 'main')
    await f.write('file', 'working edit\n')
    const review = await f.list('unstaged')
    expect(review).toMatchObject({ type: 'list', entries: [{ kind: 'tracked' }] })
    if (review.type !== 'list') return
    await f.write('file', 'main\n')
    expect(() => f.git('merge', 'other')).toThrow()
    expect(
      await f.service.dispatch({
        type: 'patch',
        projectPath: f.project,
        reviewId: review.reviewId,
        entryId: review.entries[0].entryId
      })
    ).toMatchObject({ type: 'unavailable', reason: 'stale-review' })
  })
  it.each(['symlink', 'gitlink'] as const)(
    'rejects an ordinary staged file capability after conversion to %s',
    async (kind) => {
      const f = await fixture()
      await f.write('file', 'base\n')
      f.git('add', '.')
      f.git('commit', '-qm', 'base')
      await f.write('file', 'staged edit\n')
      f.git('add', '.')
      const review = await f.list('staged')
      expect(review).toMatchObject({ type: 'list', entries: [{ kind: 'tracked' }] })
      if (review.type !== 'list') return
      if (kind === 'symlink') {
        await fs.unlink(join(f.project, 'file'))
        await fs.symlink('target', join(f.project, 'file'))
        f.git('add', '.')
      } else
        f.git('update-index', '--cacheinfo', `160000,${f.git('rev-parse', 'HEAD').trim()},file`)
      expect(
        await f.service.dispatch({
          type: 'patch',
          projectPath: f.project,
          reviewId: review.reviewId,
          entryId: review.entries[0].entryId
        })
      ).toMatchObject({ type: 'unavailable', reason: 'stale-review' })
    }
  )
  it('keeps an escaped raw fallback for non-UTF-8 text patches', async () => {
    const f = await fixture()
    await f.write('file', 'base\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'base')
    await f.write('file', Buffer.from([0xff, 0x0a]))
    const review = await f.list('unstaged')
    expect(review.type).toBe('list')
    if (review.type !== 'list') return
    expect(
      await f.service.dispatch({
        type: 'patch',
        projectPath: f.project,
        reviewId: review.reviewId,
        entryId: review.entries[0].entryId
      })
    ).toMatchObject({
      type: 'patch',
      kind: 'text',
      rawOnly: true,
      text: expect.stringContaining('\\xff')
    })
  })
  it('rejects Git versions below the verified no-lazy-fetch baseline', async () => {
    const f = await fixture((executable, args, options) =>
      args.includes('--version')
        ? spawn(process.execPath, ['-e', 'process.stdout.write("git version 2.49.0\\n")'], options)
        : spawn(executable, args, options)
    )
    expect(await f.list('unstaged')).toMatchObject({ type: 'unavailable', reason: 'git-version' })
  })
  it('marks untracked symlinks unsupported by the bounded Files preview', async () => {
    const f = await fixture()
    await fs.symlink(f.home, join(f.project, 'link'))
    const review = await f.list('unstaged')
    expect(review).toMatchObject({
      type: 'list',
      entries: [{ path: 'link', kind: 'untracked', previewUnavailable: expect.any(String) }]
    })
    if (review.type === 'list') expect(review.entries[0].previewPath).toBeUndefined()
  })
  it('shows unstaged submodule commit changes while ignoring dirty submodule file content', async () => {
    const f = await fixture()
    f.git('init', '-q', 'module')
    await f.write('module/file', 'base\n')
    f.git('-C', 'module', 'add', '.')
    f.git(
      '-C',
      'module',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'base'
    )
    f.git(
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${f.git('-C', 'module', 'rev-parse', 'HEAD').trim()},module`
    )
    f.git('commit', '-qm', 'gitlink')
    await f.write('module/file', 'changed\n')
    expect(await f.list('unstaged')).toMatchObject({ type: 'list', entries: [] })
    f.git(
      '-C',
      'module',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qam',
      'changed'
    )
    expect(await f.list('unstaged')).toMatchObject({
      type: 'list',
      entries: [{ path: 'module', kind: 'submodule', status: 'M' }]
    })
  })
  it('surfaces nested untracked repositories as unsupported previews without failing the whole inventory', async () => {
    const f = await fixture()
    f.git('init', '-q', join(f.project, 'nested'))
    await f.write('nested/new', 'new\n')
    expect(await f.list('unstaged')).toMatchObject({
      type: 'list',
      entries: [{ path: 'nested', kind: 'untracked', previewUnavailable: expect.any(String) }]
    })
  })
  it('does not mistake markers inside unusual filenames for binary or type-only patches', async () => {
    const f = await fixture()
    const name = 'line\nBinary files x differ\nold mode 100644'
    await f.write(name, 'base\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'base')
    f.git('config', 'core.quotePath', 'false')
    await f.write(name, 'changed\n')
    const review = await f.list('unstaged')
    expect(review).toMatchObject({ type: 'list', entries: [{ path: name }] })
    if (review.type !== 'list') return
    expect(
      await f.service.dispatch({
        type: 'patch',
        projectPath: f.project,
        reviewId: review.reviewId,
        entryId: review.entries[0].entryId
      })
    ).toMatchObject({
      type: 'patch',
      kind: 'text',
      text: expect.stringContaining('-base\n+changed\n')
    })
  })
  it('fails on missing promisor objects without starting a remote transport', async () => {
    const f = await fixture()
    await f.write('file', 'base\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'base')
    f.git('branch', 'base')
    const blob = f.git('rev-parse', 'HEAD:file').trim()
    await f.write('file', 'changed\n')
    f.git('commit', '-qam', 'changed')
    const review = await f.list('branch', 'refs/heads/base')
    expect(review.type).toBe('list')
    if (review.type !== 'list') return
    const sentinel = join(f.root, 'transport-executed')
    const script = join(f.root, 'transport.sh')
    await fs.writeFile(script, `#!/bin/sh\ntouch '${sentinel}'\nexit 1\n`, { mode: 0o700 })
    f.git('config', 'core.repositoryformatversion', '1')
    f.git('config', 'extensions.partialClone', 'origin')
    f.git('config', 'remote.origin.promisor', 'true')
    f.git('config', 'remote.origin.url', f.root)
    f.git('config', 'remote.origin.uploadpack', script)
    await fs.unlink(join(f.project, '.git/objects', blob.slice(0, 2), blob.slice(2)))
    // Positive control: an ordinary Git read really attempts the local transport.
    expect(() => f.git('cat-file', '-p', blob)).toThrow()
    expect((await fs.stat(sentinel)).isFile()).toBe(true)
    await fs.unlink(sentinel)
    expect(
      await f.service.dispatch({
        type: 'patch',
        projectPath: f.project,
        reviewId: review.reviewId,
        entryId: review.entries[0].entryId
      })
    ).toMatchObject({ type: 'unavailable', reason: 'git-failed' })
    await expect(fs.stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('publishes only the latest concurrent list and never accepts an older entry ID', async () => {
    let firstStatus = true
    let started!: () => void
    const pending = new Promise<void>((resolve) => {
      started = resolve
    })
    const f = await fixture((executable, args, options) => {
      if (firstStatus && args.includes('status')) {
        firstStatus = false
        started()
        return spawn(
          process.execPath,
          ['-e', 'setTimeout(() => process.stdout.write("? old\\0"), 350)'],
          options
        )
      }
      return spawn(executable, args, options)
    })
    await f.write('new', 'new\n')
    const old = f.list('unstaged')
    await pending
    const current = await f.list('unstaged')
    expect(current).toMatchObject({ type: 'list', entries: [{ path: 'new' }] })
    expect(await old).toMatchObject({ type: 'unavailable', reason: 'stale-review' })
    if (current.type !== 'list') return
    expect(
      await f.service.dispatch({
        type: 'patch',
        projectPath: f.project,
        reviewId: current.reviewId,
        entryId: 'unknown'
      })
    ).toMatchObject({ type: 'unavailable', reason: 'stale-review' })
    expect(
      await f.service.dispatch({
        type: 'patch',
        projectPath: f.project,
        reviewId: current.reviewId,
        entryId: current.entries[0].entryId
      })
    ).toMatchObject({ type: 'patch', kind: 'untracked' })
  })
  it('returns bounded failure rather than a truncated patch', async () => {
    const f = await fixture()
    await f.write('large', 'old\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'base')
    await f.write('large', 'x'.repeat(2 * 1024 * 1024) + '\n')
    const review = await f.list('unstaged')
    expect(review.type).toBe('list')
    if (review.type !== 'list') return
    expect(
      await f.service.dispatch({
        type: 'patch',
        projectPath: f.project,
        reviewId: review.reviewId,
        entryId: review.entries[0].entryId
      })
    ).toMatchObject({ type: 'unavailable', reason: 'output-limit' })
  })
  it('reports ambiguous merge bases explicitly with a bounded safe Git response fixture', async () => {
    const f = await fixture((executable, args, options) =>
      args.includes('merge-base')
        ? spawn(
            process.execPath,
            ['-e', `process.stdout.write('${'a'.repeat(40)}\\n${'b'.repeat(40)}\\n')`],
            options
          )
        : spawn(executable, args, options)
    )
    await f.write('file', 'base\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'base')
    expect(await f.list('branch', 'refs/heads/main')).toMatchObject({
      type: 'unavailable',
      reason: 'multiple-merge-bases'
    })
  })
  it('rejects an old file capability after the indexed path becomes a directory', async () => {
    const f = await fixture()
    await f.write('item', 'old\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'base')
    await f.write('item', 'edited\n')
    f.git('add', '.')
    const review = await f.list('staged')
    expect(review.type).toBe('list')
    if (review.type !== 'list') return
    await fs.unlink(join(f.project, 'item'))
    await fs.mkdir(join(f.project, 'item'))
    await f.write('item/child', 'must not appear\n')
    f.git('add', '.')
    expect(
      await f.service.dispatch({
        type: 'patch',
        projectPath: f.project,
        reviewId: review.reviewId,
        entryId: review.entries[0].entryId
      })
    ).toMatchObject({ type: 'unavailable', reason: 'stale-review' })
  })
  it('reports non-repositories, bare repositories and linked worktrees without assuming a .git directory', async () => {
    const f = await fixture()
    f.service.setProject(f.home)
    expect(await f.service.dispatch({ type: 'refs', projectPath: f.home })).toMatchObject({
      type: 'unavailable',
      reason: 'not-repository'
    })
    f.service.setProject(join(f.project, '.git'))
    // A git-dir reached directly is not a worktree, even if core.bare is false.
    expect(
      (await f.service.dispatch({ type: 'refs', projectPath: join(f.project, '.git') })).type
    ).toBe('unavailable')
    const bare = join(f.root, 'bare.git')
    f.git('init', '--bare', '-q', bare)
    f.service.setProject(bare)
    expect(await f.service.dispatch({ type: 'refs', projectPath: bare })).toMatchObject({
      type: 'unavailable',
      reason: 'bare-repository'
    })
    await f.write('file', 'base\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'base')
    const linked = join(f.root, 'linked \n')
    f.git('worktree', 'add', '--detach', '-q', linked)
    await fs.writeFile(join(linked, 'file'), 'linked change\n')
    f.service.setProject(linked)
    expect(
      await f.service.dispatch({ type: 'list', projectPath: linked, view: 'unstaged' })
    ).toMatchObject({ type: 'list', entries: [{ path: 'file' }] })
  })
  it('reports conflicts explicitly instead of manufacturing a two-way patch', async () => {
    const f = await fixture()
    await f.write('file', 'base\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'base')
    f.git('checkout', '-qb', 'other')
    await f.write('file', 'other\n')
    f.git('commit', '-qam', 'other')
    f.git('checkout', '-q', 'main')
    await f.write('file', 'main\n')
    f.git('commit', '-qam', 'main')
    expect(() => f.git('merge', 'other')).toThrow()
    const review = await f.list('unstaged')
    expect(review).toMatchObject({
      type: 'list',
      entries: [{ kind: 'conflict', indexStatus: 'U', worktreeStatus: 'U' }]
    })
    if (review.type !== 'list') return
    expect(
      await f.service.dispatch({
        type: 'patch',
        projectPath: f.project,
        reviewId: review.reviewId,
        entryId: review.entries[0].entryId
      })
    ).toMatchObject({ type: 'patch', kind: 'conflict' })
  })
  it('revokes old reviews and rejects project ABA responses with real process cancellation', async () => {
    let slow = false
    let started!: () => void
    const pending = new Promise<void>((resolve) => {
      started = resolve
    })
    let delayed: ReturnType<typeof spawn> | undefined
    const f = await fixture((executable, args, options) => {
      if (slow) {
        delayed = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], options)
        started()
        return delayed
      }
      return spawn(executable, args, options)
    })
    await f.write('file', 'new')
    const review = await f.list('unstaged')
    expect(review.type).toBe('list')
    if (review.type !== 'list') return
    slow = true
    const response = f.list('unstaged')
    await pending
    f.service.setProject(f.home)
    f.service.setProject(f.project)
    expect(await response).toMatchObject({ type: 'unavailable', reason: 'project-changed' })
    expect(delayed?.signalCode).toBe('SIGKILL')
    slow = false
    expect(
      await f.service.dispatch({
        type: 'patch',
        projectPath: f.project,
        reviewId: review.reviewId,
        entryId: review.entries[0].entryId
      })
    ).toMatchObject({ type: 'unavailable', reason: 'stale-review' })
  })
  it('does not let a wrong-project request revoke a valid review', async () => {
    const f = await fixture()
    await f.write('file', 'new')
    const review = await f.list('unstaged')
    expect(review.type).toBe('list')
    if (review.type !== 'list') return
    expect(
      await f.service.dispatch({ type: 'list', projectPath: f.home, view: 'unstaged' })
    ).toMatchObject({ type: 'unavailable', reason: 'project-changed' })
    expect(
      await f.service.dispatch({
        type: 'patch',
        projectPath: f.project,
        reviewId: review.reviewId,
        entryId: review.entries[0].entryId
      })
    ).toMatchObject({ type: 'patch', kind: 'untracked' })
  })
  it('blocks filters before scans and disables external diff, textconv and fsmonitor without changing index/files', async () => {
    const f = await fixture()
    await f.write('file.txt', 'base\n')
    await f.write('.gitattributes', '*.txt diff=fixture filter=fixture\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'base')
    await f.write('file.txt', 'working\n')
    const sentinel = join(f.root, 'executed')
    const script = join(f.root, 'sentinel.sh')
    await fs.writeFile(script, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o700 })
    for (const key of ['diff.external', 'diff.fixture.textconv', 'core.fsmonitor'])
      f.git('config', key, script)
    const index = await fs.readFile(join(f.project, '.git/index'))
    const review = await f.list('unstaged')
    expect(review.type).toBe('list')
    if (review.type !== 'list') return
    expect(
      await f.service.dispatch({
        type: 'patch',
        projectPath: f.project,
        reviewId: review.reviewId,
        entryId: review.entries[0].entryId
      })
    ).toMatchObject({ type: 'patch', kind: 'text' })
    f.git('config', 'filter.fixture.clean', script)
    expect(await f.list('unstaged')).toMatchObject({
      type: 'unavailable',
      reason: 'filters-unsupported'
    })
    f.git('config', '--unset', 'filter.fixture.clean')
    f.git('config', 'filter.fixture.process', script)
    expect(await f.list('staged')).toMatchObject({
      type: 'unavailable',
      reason: 'filters-unsupported'
    })
    expect(await fs.readFile(join(f.project, '.git/index'))).toEqual(index)
    expect(await fs.readFile(join(f.project, 'file.txt'), 'utf8')).toBe('working\n')
    await expect(fs.stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('scopes nested projects, preserves odd names, and serves deleted historical patches', async () => {
    const f = await fixture()
    await fs.mkdir(join(f.project, 'nested '))
    await f.write('outside.txt', 'private sibling\n')
    await f.write('nested /old.txt', 'old\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'base')
    await fs.rename(join(f.project, 'nested /old.txt'), join(f.project, 'moved.txt'))
    for (const name of ['-dash', ':colon', 'back\\slash', 'tab\tname', 'line\nname', ' 中文 '])
      await f.write(`nested /${name}`, 'new\n')
    f.service.setProject(join(f.project, 'nested '))
    const review = await f.service.dispatch({
      type: 'list',
      projectPath: join(f.project, 'nested '),
      view: 'unstaged'
    })
    expect(review.type).toBe('list')
    if (review.type !== 'list') return
    expect(review.entries.map((e) => e.path).sort()).toEqual(
      ['old.txt', '-dash', ':colon', 'back\\slash', 'tab\tname', 'line\nname', ' 中文 '].sort()
    )
    expect(review.entries.find((e) => e.path === ':colon')).toMatchObject({
      kind: 'untracked',
      previewUnavailable: expect.any(String)
    })
    const deleted = review.entries.find((e) => e.path === 'old.txt')!
    expect(
      await f.service.dispatch({
        type: 'patch',
        projectPath: join(f.project, 'nested '),
        reviewId: review.reviewId,
        entryId: deleted.entryId
      })
    ).toMatchObject({ type: 'patch', kind: 'text', text: expect.stringContaining('-old\n') })
  })
  it('reports binary, symlink and gitlink entries truthfully in staged and branch comparisons', async () => {
    const f = await fixture()
    await f.write('base', 'base\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'base')
    f.git('branch', 'base')
    await f.write('binary', Buffer.from([0, 1, 2]))
    await fs.symlink('base', join(f.project, 'link'))
    f.git('add', '.')
    f.git(
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${f.git('rev-parse', 'HEAD').trim()},module`
    )
    for (const view of ['staged', 'branch'] as const) {
      if (view === 'branch') f.git('commit', '-qm', 'special files')
      const review = await f.list(view, view === 'branch' ? 'refs/heads/base' : undefined)
      expect(review.type).toBe('list')
      if (review.type !== 'list') return
      expect(review.entries.find((e) => e.path === 'module')).toMatchObject({ kind: 'submodule' })
      expect(review.entries.find((e) => e.path === 'link')).toMatchObject({ kind: 'symlink' })
      const binary = review.entries.find((e) => e.path === 'binary')!
      expect(
        await f.service.dispatch({
          type: 'patch',
          projectPath: f.project,
          reviewId: review.reviewId,
          entryId: binary.entryId
        })
      ).toMatchObject({ type: 'patch', kind: 'binary' })
    }
  })
  it('lists local refs, requires a selected base and pins branch patches to committed OIDs', async () => {
    const f = await fixture()
    expect(await f.list('branch')).toMatchObject({ type: 'unavailable', reason: 'select-base' })
    await f.write('file.txt', 'base\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'base')
    f.git('branch', 'base')
    await f.write('file.txt', 'committed\n')
    f.git('commit', '-qam', 'topic')
    f.git('checkout', '--detach', '-q')
    expect(await f.service.dispatch({ type: 'refs', projectPath: f.project })).toMatchObject({
      type: 'refs',
      refs: expect.arrayContaining([{ name: 'refs/heads/base', label: 'base' }])
    })
    expect(await f.list('branch', 'refs/heads/missing')).toMatchObject({
      type: 'unavailable',
      reason: 'invalid-base'
    })
    const review = await f.list('branch', 'refs/heads/base')
    expect(review).toMatchObject({
      type: 'list',
      entries: [{ path: 'file.txt' }],
      branch: { baseRef: 'refs/heads/base' }
    })
    if (review.type !== 'list') return
    await f.write('file.txt', 'later\n')
    f.git('commit', '-qam', 'later')
    expect(
      await f.service.dispatch({
        type: 'patch',
        projectPath: f.project,
        reviewId: review.reviewId,
        entryId: review.entries[0].entryId
      })
    ).toMatchObject({ type: 'patch', text: expect.stringContaining('-base\n+committed\n') })
    f.git('checkout', '--orphan', 'unrelated', '-q')
    f.git('commit', '-qm', 'unrelated root')
    expect(await f.list('branch', 'refs/heads/base')).toMatchObject({
      type: 'unavailable',
      reason: 'no-common-ancestor'
    })
  })
  it('keeps partially staged comparisons separate and supports unborn staged additions', async () => {
    const f = await fixture()
    await f.write('file.txt', 'base\n')
    f.git('add', '--', 'file.txt')
    const unborn = await f.list('staged')
    expect(unborn.type).toBe('list')
    if (unborn.type !== 'list') return
    expect(unborn.entries).toMatchObject([{ path: 'file.txt', status: 'A' }])
    f.git('commit', '-qm', 'base')
    await f.write('file.txt', 'staged\n')
    f.git('add', '--', 'file.txt')
    await f.write('file.txt', 'working\n')
    const staged = await f.list('staged')
    expect(staged.type).toBe('list')
    if (staged.type !== 'list') return
    const stagedPatch = await f.service.dispatch({
      type: 'patch',
      projectPath: f.project,
      reviewId: staged.reviewId,
      entryId: staged.entries[0].entryId
    })
    expect(stagedPatch).toMatchObject({
      type: 'patch',
      kind: 'text',
      text: expect.stringContaining('-base\n+staged\n')
    })
    const working = await f.list('unstaged')
    expect(working.type).toBe('list')
    if (working.type !== 'list') return
    expect(
      await f.service.dispatch({
        type: 'patch',
        projectPath: f.project,
        reviewId: working.reviewId,
        entryId: working.entries[0].entryId
      })
    ).toMatchObject({
      type: 'patch',
      kind: 'text',
      text: expect.stringContaining('-staged\n+working\n')
    })
  })
})
