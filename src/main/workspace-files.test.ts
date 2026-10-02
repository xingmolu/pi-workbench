import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { WorkspaceFiles } from './workspace-files'

describe('bounded workspace files', () => {
  let root: string
  let service: WorkspaceFiles
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-files-')))
    service = new WorkspaceFiles()
    service.setProject(root)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })
  const read = (projectPath: string, path: string) => ({ type: 'read' as const, projectPath, path })
  it('requires current project and rejects mismatches without leaking paths', async () => {
    service.setProject(null)
    await expect(service.dispatch(read(root, 'a'))).rejects.toThrow('尚未打开项目')
    service.setProject(root)
    await expect(service.dispatch(read('/private/other', 'a'))).rejects.toThrow('项目已切换')
  })
  it('reads only regular UTF8 bounded text', async () => {
    await writeFile(join(root, 'ok'), '你好')
    expect(await service.dispatch(read(root, 'ok'))).toEqual({
      type: 'read',
      path: 'ok',
      text: '你好',
      size: 6
    })
    for (const [name, data] of [
      ['nul', Buffer.from([0])],
      ['invalid', Buffer.from([255])],
      ['large', Buffer.alloc(1024 * 1024 + 1, 65)]
    ] as const)
      await writeFile(join(root, name), data)
    await mkdir(join(root, 'dir'))
    for (const name of ['nul', 'invalid'])
      await expect(service.dispatch(read(root, name))).rejects.toThrow('二进制')
    await expect(service.dispatch(read(root, 'large'))).rejects.toThrow('1 MiB')
    await expect(service.dispatch(read(root, 'dir'))).rejects.toThrow('普通文件')
    await expect(service.dispatch(read(root, 'missing'))).rejects.toThrow('文件不存在')
  })
  it('rejects symlink segments and exposes disabled symlinks in lists', async () => {
    await mkdir(join(root, 'dir'))
    await writeFile(join(root, 'dir', 'a'), 'a')
    await symlink(join(root, 'dir'), join(root, 'link'))
    await expect(service.dispatch(read(root, 'link/a'))).rejects.toThrow('符号链接')
    expect(await service.dispatch({ type: 'list', projectPath: root, path: '' })).toMatchObject({
      entries: [
        { name: 'dir', kind: 'directory' },
        { name: 'link', kind: 'symlink' }
      ]
    })
  })
  it('lists directories first and hides dot files and always .git', async () => {
    for (const name of ['z', 'a', '.hidden']) await writeFile(join(root, name), '')
    for (const name of ['b', '.git']) await mkdir(join(root, name))
    expect(await service.dispatch({ type: 'list', projectPath: root, path: '' })).toMatchObject({
      entries: [{ name: 'b' }, { name: 'a' }, { name: 'z' }],
      truncated: false
    })
    const result = await service.dispatch({
      type: 'list',
      projectPath: root,
      path: '',
      includeHidden: true
    })
    expect('entries' in result && result.entries.map((e) => e.name)).toEqual([
      'b',
      '.hidden',
      'a',
      'z'
    ])
  })
  it('sorts names numerically within directories and files', async () => {
    for (const name of ['file10', 'file2']) await writeFile(join(root, name), '')
    expect(await service.dispatch({ type: 'list', projectPath: root })).toMatchObject({
      entries: [{ name: 'file2' }, { name: 'file10' }]
    })
  })
  it('never reads special files or Git internals', async () => {
    // Windows has no named pipes in the file system.
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [join(root, 'pipe')])
      await expect(service.dispatch(read(root, 'pipe'))).rejects.toThrow('普通文件')
    }
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'config'), 'secret')
    await expect(service.dispatch(read(root, '.git/config'))).rejects.toThrow('Git 内部')
  })
  it('excludes Git internals regardless of directory casing', async () => {
    await mkdir(join(root, '.GIT'))
    await writeFile(join(root, '.GIT', 'config'), 'secret')
    await expect(service.dispatch(read(root, '.GIT/config'))).rejects.toThrow('Git 内部')
    await expect(
      service.dispatch({ type: 'list', projectPath: root, path: '.GIT', includeHidden: true })
    ).rejects.toThrow('Git 内部')
    expect(
      await service.dispatch({ type: 'list', projectPath: root, includeHidden: true })
    ).toMatchObject({ entries: [] })
    expect(
      await service.dispatch({
        type: 'search',
        projectPath: root,
        query: 'config',
        includeHidden: true
      })
    ).toMatchObject({ entries: [] })
  })
  it('bounds search visits even without matching names', async () => {
    await Promise.all(
      Array.from({ length: 5001 }, (_, i) => writeFile(join(root, `file-${i}`), ''))
    )
    expect(await service.dispatch({ type: 'search', projectPath: root, query: 'absent' })).toEqual({
      type: 'search',
      entries: [],
      truncated: true
    })
  })
  it('caps directory listings and search results truthfully', async () => {
    await Promise.all(
      Array.from({ length: 1001 }, (_, i) => writeFile(join(root, `match-${i}`), ''))
    )
    const list = await service.dispatch({ type: 'list', projectPath: root, path: '' })
    expect('entries' in list && list.entries).toHaveLength(1000)
    expect(list).toMatchObject({ truncated: true })
    const search = await service.dispatch({ type: 'search', projectPath: root, query: 'match' })
    expect('entries' in search && search.entries).toHaveLength(200)
    expect(search).toMatchObject({ truncated: true })
  })
  it('searches file names, skips ignored directories and limits depth', async () => {
    for (const name of ['node_modules', 'dist', 'out', '.git']) {
      await mkdir(join(root, name))
      await writeFile(join(root, name, 'needle'), '')
    }
    await writeFile(join(root, 'content'), 'needle')
    await writeFile(join(root, 'needle'), '')
    await symlink(root, join(root, 'loop'))
    const deep = Array(13).fill('deep').join('/')
    await mkdir(join(root, deep), { recursive: true })
    await writeFile(join(root, deep, 'needle'), '')
    expect(
      await service.dispatch({
        type: 'search',
        projectPath: root,
        query: 'needle',
        includeHidden: true
      })
    ).toMatchObject({ entries: [{ name: 'needle' }], truncated: true })
  })
  it.each([false, true])('rejects delayed project transitions including ABA=%s', async (back) => {
    await writeFile(join(root, 'ok'), 'a')
    const original = fs.realpath
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(fs, 'realpath').mockImplementationOnce(async (path) => {
      await gate
      return original(path)
    })
    const pending = service.dispatch(read(root, 'ok'))
    service.setProject('/different')
    if (back) service.setProject(root)
    release()
    await expect(pending).rejects.toThrow('项目已切换')
  })
  it('handles files disappearing after validation', async () => {
    await writeFile(join(root, 'gone'), '')
    vi.spyOn(fs, 'open').mockRejectedValueOnce(
      Object.assign(new Error(`secret ${root}`), { code: 'ENOENT' })
    )
    await expect(service.dispatch(read(root, 'gone'))).rejects.toThrow('文件不存在')
  })
})
