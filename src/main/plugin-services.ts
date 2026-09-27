import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  PLUGIN_FS_MAX_ENTRIES,
  PLUGIN_FS_MAX_READ_BYTES,
  PluginApiError
} from '../shared/plugin-api'
import type { GitProcessResult, GitReviewProcess } from './git-review-process'

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Resolves a project-relative path and proves it stays inside the project after resolving
 * symlinks on the deepest existing ancestor. The project root itself is canonicalized too.
 */
export async function resolveInProject(projectPath: string, path: string): Promise<string> {
  const root = await realpath(projectPath)
  const target = resolve(root, path)
  if (!inside(root, target)) throw new PluginApiError('PERMISSION_DENIED', '路径不在项目内')
  let existing = target
  const rest: string[] = []
  for (;;) {
    try {
      await lstat(existing)
      break
    } catch {
      const parent = dirname(existing)
      if (parent === existing) break
      rest.unshift(existing.slice(parent.length + 1))
      existing = parent
    }
  }
  const real = join(await realpath(existing), ...rest)
  if (!inside(root, real)) throw new PluginApiError('PERMISSION_DENIED', '路径不在项目内')
  return real
}

function notFound(error: unknown): never {
  if ((error as { code?: string }).code === 'ENOENT')
    throw new PluginApiError('NOT_FOUND', '文件不存在')
  throw error
}

export type PluginFileEntry = { name: string; kind: 'file' | 'directory' | 'symlink' | 'other' }

/** File access for plugins, always relative to the open project. */
export class PluginFileService {
  async list(
    projectPath: string,
    path: string
  ): Promise<{ entries: PluginFileEntry[]; truncated: boolean }> {
    const directory = await resolveInProject(projectPath, path)
    const children = await readdir(directory, { withFileTypes: true }).catch(notFound)
    const entries = children
      .filter((child) => child.name !== '.git')
      .slice(0, PLUGIN_FS_MAX_ENTRIES)
      .map((child) => ({
        name: child.name,
        kind: child.isDirectory()
          ? ('directory' as const)
          : child.isFile()
            ? ('file' as const)
            : child.isSymbolicLink()
              ? ('symlink' as const)
              : ('other' as const)
      }))
      .sort((left, right) =>
        left.kind === right.kind
          ? left.name.localeCompare(right.name)
          : left.kind === 'directory'
            ? -1
            : right.kind === 'directory'
              ? 1
              : 0
      )
    return { entries, truncated: children.length > PLUGIN_FS_MAX_ENTRIES }
  }

  async stat(
    projectPath: string,
    path: string
  ): Promise<{ kind: PluginFileEntry['kind']; size: number; modified: string }> {
    const target = await resolveInProject(projectPath, path)
    const stat = await lstat(target).catch(notFound)
    return {
      kind: stat.isDirectory()
        ? 'directory'
        : stat.isFile()
          ? 'file'
          : stat.isSymbolicLink()
            ? 'symlink'
            : 'other',
      size: stat.size,
      modified: stat.mtime.toISOString()
    }
  }

  async readText(projectPath: string, path: string): Promise<{ text: string }> {
    const target = await resolveInProject(projectPath, path)
    const stat = await lstat(target).catch(notFound)
    if (!stat.isFile()) throw new PluginApiError('INVALID_ARGUMENT', '只能读取普通文件')
    if (stat.size > PLUGIN_FS_MAX_READ_BYTES)
      throw new PluginApiError('INVALID_ARGUMENT', '文件超过 1 MiB')
    const bytes = await readFile(target)
    try {
      if (bytes.includes(0)) throw new Error('binary')
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    } catch {
      throw new PluginApiError('INVALID_ARGUMENT', '只能读取 UTF-8 文本文件')
    }
  }

  async writeText(projectPath: string, path: string, content: string): Promise<void> {
    const target = await resolveInProject(projectPath, path)
    const existing = await lstat(target).catch(() => null)
    if (existing && !existing.isFile())
      throw new PluginApiError('INVALID_ARGUMENT', '只能写入普通文件')
    await mkdir(dirname(target), { recursive: true })
    // Re-check after creating parents: a racing symlink must not redirect the write.
    const verified = await resolveInProject(projectPath, path)
    if (verified !== target) throw new PluginApiError('CONFLICT', '路径在写入前发生了变化')
    await writeFile(target, content, 'utf8')
  }
}

export type PluginGitStatus = {
  branch: string | null
  ahead: number
  behind: number
  files: { path: string; index: string; worktree: string }[]
}

/**
 * Git for plugins over the hardened review runner: no hooks, no fsmonitor, no global or
 * system config, no terminal prompts, and repositories with clean/process filters refused
 * because staging and diffing would execute them.
 */
export class PluginGitService {
  constructor(
    private readonly process: Pick<GitReviewProcess, 'run'>,
    /** The user's own commit identity, read outside the hardened runner (which ignores
     * global config). Only these two values cross over; no other global setting does. */
    private readonly identity: () => Promise<{ name: string; email: string } | null> = async () =>
      null
  ) {}

  private async run(
    cwd: string,
    args: string[],
    budget: 'status' | 'patch' = 'status'
  ): Promise<string> {
    const result: GitProcessResult = await this.process.run({ cwd, args, budget })
    if (result.ok) return result.stdout.toString('utf8')
    if (result.reason === 'exit' && result.stderrKind === 'not-repository')
      throw new PluginApiError('NOT_FOUND', '项目不是 Git 仓库')
    if (result.reason === 'timeout') throw new PluginApiError('TIMEOUT', 'Git 操作超时')
    if (result.reason === 'stdout-limit')
      throw new PluginApiError('INVALID_ARGUMENT', 'Git 输出过大')
    throw new PluginApiError('INTERNAL', 'Git 操作失败')
  }

  /** Commands run in the project directory, which may be a subdirectory of the repository. */
  private async root(projectPath: string): Promise<string> {
    const root = await realpath(projectPath)
    await this.run(root, ['rev-parse', '--show-toplevel'])
    const filters = await this.process.run({
      cwd: root,
      args: ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$'],
      budget: 'status'
    })
    if (
      filters.ok
        ? filters.stdout.length > 0
        : !(filters.reason === 'exit' && filters.exitCode === 1)
    )
      throw new PluginApiError(
        'UNSUPPORTED',
        '仓库配置了 clean/process 过滤器，插件不能安全地操作它'
      )
    return root
  }

  async status(projectPath: string): Promise<PluginGitStatus> {
    const root = await this.root(projectPath)
    // Porcelain paths are repository-relative; report them relative to the project instead.
    const prefix = (await this.run(root, ['rev-parse', '--show-prefix'])).trim()
    const text = await this.run(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '-b',
      '--untracked-files=all',
      '--no-renames',
      '--',
      '.'
    ])
    const records = text.split('\0').filter(Boolean)
    const status: PluginGitStatus = { branch: null, ahead: 0, behind: 0, files: [] }
    for (const record of records) {
      if (record.startsWith('## ')) {
        const header = record.slice(3)
        status.branch = header.startsWith('No commits yet on ')
          ? header.slice('No commits yet on '.length)
          : header.split('...')[0].split(' ')[0] || null
        status.ahead = Number(/ahead (\d+)/.exec(header)?.[1] ?? 0)
        status.behind = Number(/behind (\d+)/.exec(header)?.[1] ?? 0)
        continue
      }
      const path = record.slice(3)
      status.files.push({
        index: record[0],
        worktree: record[1],
        path: prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path
      })
    }
    return status
  }

  async diff(
    projectPath: string,
    path: string | undefined,
    staged: boolean
  ): Promise<{ patch: string }> {
    const root = await this.root(projectPath)
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames']
    if (staged) args.push('--cached')
    if (path) args.push('--', await this.pathspec(root, projectPath, path))
    return { patch: await this.run(root, args, 'patch') }
  }

  async log(
    projectPath: string,
    limit: number
  ): Promise<{ commits: { hash: string; subject: string; author: string; date: string }[] }> {
    const root = await this.root(projectPath)
    const text = await this.process.run({
      cwd: root,
      args: ['log', `--max-count=${limit}`, '--format=%H%x1f%s%x1f%an%x1f%aI%x1e'],
      budget: 'status'
    })
    // A repository without commits has no log; that is an empty history, not an error.
    if (!text.ok) return { commits: [] }
    return {
      commits: text.stdout
        .toString('utf8')
        .split('\x1e')
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record) => {
          const [hash, subject, author, date] = record.split('\x1f')
          return { hash, subject, author, date }
        })
    }
  }

  async stage(projectPath: string, paths: string[]): Promise<void> {
    const root = await this.root(projectPath)
    await this.run(root, ['add', '--', ...(await this.pathspecs(root, projectPath, paths))])
  }

  async unstage(projectPath: string, paths: string[]): Promise<void> {
    const root = await this.root(projectPath)
    await this.run(root, [
      'restore',
      '--staged',
      '--',
      ...(await this.pathspecs(root, projectPath, paths))
    ])
  }

  async discard(projectPath: string, paths: string[]): Promise<void> {
    const root = await this.root(projectPath)
    await this.run(root, [
      'restore',
      '--worktree',
      '--',
      ...(await this.pathspecs(root, projectPath, paths))
    ])
  }

  async commit(projectPath: string, message: string): Promise<{ hash: string }> {
    const root = await this.root(projectPath)
    const local = await this.process.run({
      cwd: root,
      args: ['config', '--get', 'user.email'],
      budget: 'status'
    })
    const identity = local.ok && local.stdout.length > 0 ? null : await this.identity()
    await this.run(root, [
      ...(identity
        ? ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`]
        : []),
      'commit',
      '--no-verify',
      '--no-edit',
      '-m',
      message
    ])
    return { hash: (await this.run(root, ['rev-parse', 'HEAD'])).trim() }
  }

  private async pathspec(root: string, projectPath: string, path: string): Promise<string> {
    const absolute = await resolveInProject(projectPath, path)
    const rel = relative(root, absolute)
    if (!inside(root, absolute)) throw new PluginApiError('PERMISSION_DENIED', '路径不在仓库内')
    return rel.split(sep).join('/') || '.'
  }

  private async pathspecs(root: string, projectPath: string, paths: string[]): Promise<string[]> {
    return Promise.all(paths.map((path) => this.pathspec(root, projectPath, path)))
  }
}
