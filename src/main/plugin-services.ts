import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  PLUGIN_FS_MAX_ENTRIES,
  PLUGIN_FS_MAX_READ_BYTES,
  PluginApiError
} from '../shared/plugin-api'
import { execFile } from 'node:child_process'
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

export type PluginGitPushResult = { ok: true } | { ok: false; stderr: string; timedOut: boolean }

/** Runs `git push` with the user's own configuration, so credential helpers and SSH keys work. */
export type PluginGitPushRunner = (cwd: string, args: string[]) => Promise<PluginGitPushResult>

/** What a push will send, shown to the user before it runs. */
export type PluginGitPushPlan = {
  root: string
  branch: string
  head: string
  remote: string
  url: string
  remoteBranch: string
  setUpstream: boolean
  commits: { hash: string; subject: string }[]
  moreCommits: number
}

/**
 * Repository-local settings that would run a program or redirect where a push goes. A push
 * reads the user's own config for credentials, so the repository's config must not be able
 * to add these on top.
 */
const UNSAFE_PUSH_CONFIG =
  /^(?:core\.(?:sshcommand|gitproxy|askpass|hookspath|fsmonitor)|credential\..*|url\..*|include\..*|includeif\..*|protocol\..*|remote\..*\.(?:receivepack|uploadpack|vcs|proxy)|http\..*proxy|extensions\.worktreeconfig)$/

/** Credentials never belong in text shown to the user. */
function redactUrl(url: string): string {
  return url.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s'"]*@/gi, '$1')
}

function pushFailure(stderr: string, timedOut: boolean): PluginApiError {
  if (timedOut) return new PluginApiError('TIMEOUT', '推送超时')
  if (/\[rejected\]|non-fast-forward|fetch first/.test(stderr))
    return new PluginApiError('CONFLICT', '远程有新的提交，请先拉取合并后再推送')
  if (
    /Authentication failed|could not read (?:Username|Password)|Permission denied|terminal prompts disabled|403/.test(
      stderr
    )
  )
    return new PluginApiError(
      'PERMISSION_DENIED',
      '推送需要凭据：请先配置凭据助手或 SSH 密钥（可在终端中完成一次推送）'
    )
  const line = redactUrl(
    stderr
      .split('\n')
      .map((text) => text.trim())
      .find((text) => /^(?:fatal|error|remote):/.test(text)) ?? ''
  )
  return new PluginApiError('INTERNAL', line ? `推送失败：${line.slice(0, 300)}` : '推送失败')
}

export type PluginGitStatus = {
  branch: string | null
  /** The tracked remote branch, e.g. `origin/main`; null before the first push. */
  upstream: string | null
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
      null,
    private readonly pushRunner?: PluginGitPushRunner
  ) {}

  private async optional(cwd: string, args: string[]): Promise<string | null> {
    const result = await this.process.run({ cwd, args, budget: 'status' })
    return result.ok ? result.stdout.toString('utf8').trim() : null
  }

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
    const status: PluginGitStatus = {
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: []
    }
    for (const record of records) {
      if (record.startsWith('## ')) {
        const header = record.slice(3)
        status.branch = header.startsWith('No commits yet on ')
          ? header.slice('No commits yet on '.length)
          : header.split('...')[0].split(' ')[0] || null
        status.upstream = header.includes('...') ? header.split('...')[1].split(' ')[0] : null
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

  /** Everything the confirmation shows is read here, through the hardened runner. */
  async pushPlan(projectPath: string): Promise<PluginGitPushPlan> {
    const root = await this.root(projectPath)
    const branch = await this.optional(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (!branch) throw new PluginApiError('CONFLICT', '当前不在任何分支上，无法推送')
    const head = await this.optional(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    if (!head) throw new PluginApiError('CONFLICT', '还没有提交，无法推送')
    // Without --local, git follows includes and reads worktree config too; the hardened
    // runner already excludes system and global config, so this is the repository's own.
    const repositoryConfig = await this.optional(root, [
      'config',
      '--show-scope',
      '--name-only',
      '--list'
    ])
    if (repositoryConfig === null)
      throw new PluginApiError('UNSUPPORTED', '无法读取仓库配置，插件不能代为推送')
    // The runner's own `-c` overrides appear with the `command` scope; they are not the repo's.
    const unsafe = repositoryConfig
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(([scope]) => scope !== 'command')
      .map(([, key = '']) => key.trim())
      .find((key) => UNSAFE_PUSH_CONFIG.test(key.toLowerCase()))
    if (unsafe)
      throw new PluginApiError(
        'UNSUPPORTED',
        `仓库配置了 ${unsafe}，插件不能代为推送，请在终端中推送`
      )

    const configuredRemote = await this.optional(root, [
      'config',
      '--get',
      `branch.${branch}.remote`
    ])
    const merge = await this.optional(root, ['config', '--get', `branch.${branch}.merge`])
    let remote: string
    let remoteBranch: string
    let setUpstream = false
    if (configuredRemote && configuredRemote !== '.' && merge?.startsWith('refs/heads/')) {
      remote = configuredRemote
      remoteBranch = merge.slice('refs/heads/'.length)
    } else {
      const remotes = ((await this.optional(root, ['remote'])) ?? '').split('\n').filter(Boolean)
      const chosen = remotes.includes('origin')
        ? 'origin'
        : remotes.length === 1
          ? remotes[0]
          : null
      if (!chosen) throw new PluginApiError('NOT_FOUND', '没有可推送的远程仓库')
      remote = chosen
      remoteBranch = branch
      setUpstream = true
    }
    const refFormat = await this.process.run({
      cwd: root,
      args: ['check-ref-format', `refs/heads/${remoteBranch}`],
      budget: 'status'
    })
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote) || !refFormat.ok)
      throw new PluginApiError('UNSUPPORTED', '远程仓库或分支名称无法安全推送')
    const url =
      (await this.optional(root, ['config', '--get', `remote.${remote}.pushurl`])) ??
      (await this.optional(root, ['config', '--get', `remote.${remote}.url`]))
    if (!url) throw new PluginApiError('NOT_FOUND', `远程仓库 ${remote} 没有地址`)

    const tracking = `refs/remotes/${remote}/${remoteBranch}`
    const hasTracking =
      (await this.optional(root, ['rev-parse', '--verify', '--quiet', tracking])) !== null
    const range = hasTracking ? [`${tracking}..${head}`] : [head, '--not', `--remotes=${remote}`]
    const total = Number((await this.optional(root, ['rev-list', '--count', ...range])) ?? 0)
    const log =
      (await this.optional(root, ['log', '--max-count=20', '--format=%H%x1f%s', ...range])) ?? ''
    const commits = log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, subject] = line.split('\x1f')
        return { hash, subject }
      })
    if (commits.length === 0 && hasTracking)
      throw new PluginApiError('CONFLICT', '没有需要推送的提交')
    return {
      root,
      branch,
      head,
      remote,
      url: redactUrl(url),
      remoteBranch,
      setUpstream,
      commits,
      moreCommits: Math.max(0, total - commits.length)
    }
  }

  /** Pushes exactly the approved commit to the approved remote branch. */
  async push(plan: PluginGitPushPlan): Promise<{ remote: string; branch: string }> {
    if (!this.pushRunner) throw new PluginApiError('UNSUPPORTED', '此环境不支持推送')
    const head = await this.optional(plan.root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    const branch = await this.optional(plan.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (head !== plan.head || branch !== plan.branch)
      throw new PluginApiError('CONFLICT', '确认后仓库发生了变化，推送已取消')
    const result = await this.pushRunner(plan.root, [
      'push',
      '--porcelain',
      plan.remote,
      `${plan.head}:refs/heads/${plan.remoteBranch}`
    ])
    if (!result.ok) throw pushFailure(result.stderr, result.timedOut)
    if (plan.setUpstream) {
      await this.run(plan.root, ['config', `branch.${plan.branch}.remote`, plan.remote])
      await this.run(plan.root, [
        'config',
        `branch.${plan.branch}.merge`,
        `refs/heads/${plan.remoteBranch}`
      ])
    }
    return { remote: plan.remote, branch: plan.remoteBranch }
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

/**
 * The push path. Unlike the review runner it keeps the user's environment and global config,
 * because that is where credential helpers, SSH agents and proxies live. Repository hooks and
 * fsmonitor stay disabled on the command line, prompts are off, and repository-local settings
 * that could run a program are refused before this is reached (see `pushPlan`).
 */
export function createUserGitPushRunner(options: {
  gitPath: string
  hooksPath: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}): PluginGitPushRunner {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    // Variables that point git at another repository, config or program are not inherited.
    if (/^GIT_/.test(key) && !/^GIT_(?:SSH|SSH_COMMAND|SSH_VARIANT|PROXY_SSL_.*)$/.test(key))
      continue
    if (key === 'SSH_ASKPASS') continue
    env[key] = value
  }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GCM_INTERACTIVE = 'never'
  return (cwd, args) =>
    new Promise((resolve) => {
      execFile(
        options.gitPath,
        [
          '-c',
          `core.hooksPath=${options.hooksPath}`,
          '-c',
          'core.fsmonitor=false',
          '-c',
          'protocol.ext.allow=never',
          ...args
        ],
        {
          cwd,
          env,
          timeout: options.timeoutMs ?? 120_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ ok: true })
          resolve({
            ok: false,
            // --porcelain reports per-ref rejections on stdout.
            stderr: `${String(stdout)}\n${String(stderr)}`,
            timedOut: (error as { killed?: boolean }).killed === true
          })
        }
      ).stdin?.end()
    })
}
