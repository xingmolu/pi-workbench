import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, join } from 'node:path'
import { workspaceFilesCommandSchema } from '../shared/workspace-files'
import {
  gitReviewCommandSchema,
  gitReviewRefSchema,
  type GitReviewEntry,
  type GitReviewResult,
  type GitReviewUnavailableReason,
  type GitReviewView,
  type GitReviewBranch
} from '../shared/git-review'
import {
  GitReviewProcess,
  type GitProcessOptions,
  type GitProcessResult
} from './git-review-process'
import {
  GitInventoryError,
  parseGitStatus,
  parseGitNameStatus,
  parseGitRaw,
  validateGitInventoryPath
} from './git-review-parser'

const messages: Record<GitReviewUnavailableReason, string> = {
  'invalid-request': '无效的 Git Review 请求',
  'no-project': '尚未打开项目',
  'project-changed': '项目已切换，请刷新',
  'project-unavailable': '项目目录不可用，请重新打开项目',
  'stale-review': '差异清单已过期，请刷新',
  'git-unavailable': '可信 Git 程序不可用',
  'git-version': '需要 Git 2.50.1 或更新版本以禁止缺失对象自动下载',
  'not-repository': '当前项目不在 Git 工作区中',
  'bare-repository': '裸仓库没有可查看的工作区',
  'filters-unsupported': '仓库配置了 clean/process 过滤器，暂不支持安全的只读差异扫描',
  'select-base': '请选择本地基准分支',
  'invalid-base': '所选基准分支不可用，请刷新分支列表',
  unborn: '当前分支尚无提交',
  'no-common-ancestor': '基准与当前提交没有共同祖先',
  'multiple-merge-bases': '存在多个共同基准，暂不支持此分支比较',
  'unsupported-inventory': 'Git 文件清单包含不支持的名称或格式',
  timeout: 'Git 请求超时，请重试',
  aborted: 'Git 请求已取消',
  'output-limit': 'Git 输出超过大小限制，无法提供完整结果',
  busy: 'Git 请求过多，请稍后重试',
  'git-failed': '无法读取 Git 数据，所需对象可能不可用'
}
class ReviewFailure extends Error {
  constructor(readonly reason: GitReviewUnavailableReason) {
    super(messages[reason])
  }
}
function fail(reason: GitReviewUnavailableReason): never {
  throw new ReviewFailure(reason)
}
const decode = (bytes: Buffer): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return fail('unsupported-inventory')
  }
}
const line = (bytes: Buffer): string => decode(bytes).replace(/\n$/, '')
const oid = (value: string): string =>
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) ? value : fail('git-failed')
const diffFlags = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--no-renames',
  '--ignore-submodules=dirty'
]
const MAX_REVIEW_ENTRIES = 5000
const POSTPROCESS_BUDGET_MS = 5000
type Review = {
  id: string
  root: string
  scope: string
  view: GitReviewView
  branch?: GitReviewBranch
  entries: Map<string, { path: string; dto: GitReviewEntry }>
}

/** Main authority, not an OS sandbox against concurrent hostile local configuration changes. */
export class GitReview {
  private readonly process: GitReviewProcess
  private readonly capability: Promise<GitProcessResult>
  private project: string | null = null
  private epoch = 0
  private listSequence = 0
  private review: Review | undefined
  private readonly controllers = new Set<AbortController>()
  constructor(options: GitProcessOptions) {
    this.process = new GitReviewProcess({
      ...options,
      trustedEnv: { ...options.trustedEnv, LC_ALL: 'C' }
    })
    // Startup capability check runs in the host directory, before any repository access.
    this.capability = this.process.run({
      cwd: options.hooksPath,
      args: ['--version'],
      budget: 'status'
    })
  }
  setProject(path: string | null): void {
    if (path === this.project) return
    this.project = path
    this.epoch++
    this.listSequence++
    this.review = undefined
    for (const controller of this.controllers) controller.abort()
  }
  async dispatch(command: unknown): Promise<GitReviewResult> {
    const parsed = gitReviewCommandSchema.safeParse(command)
    if (!parsed.success)
      return {
        type: 'unavailable',
        reason: 'invalid-request',
        message: messages['invalid-request']
      }
    const request = parsed.data
    const epoch = this.epoch
    const project = this.project
    let sequence = this.listSequence
    let processingDeadline: number | undefined
    const controller = new AbortController()
    this.controllers.add(controller)
    const check = (): void => {
      if (epoch !== this.epoch || request.projectPath !== this.project) fail('project-changed')
      if (request.type === 'list' && sequence !== this.listSequence) fail('stale-review')
      if (processingDeadline !== undefined && performance.now() >= processingDeadline)
        fail('timeout')
    }
    const checkInventory = (count: number): void => {
      processingDeadline ??= performance.now() + POSTPROCESS_BUDGET_MS
      check()
      if (count > MAX_REVIEW_ENTRIES) fail('output-limit')
    }
    const run = async (
      cwd: string,
      args: string[],
      budget: 'status' | 'patch' = 'status'
    ): Promise<GitProcessResult> => {
      check()
      const result = await this.process.run({ cwd, args, budget, signal: controller.signal })
      check()
      return result
    }
    const output = async (
      cwd: string,
      args: string[],
      budget: 'status' | 'patch' = 'status'
    ): Promise<Buffer> => {
      const result = await run(cwd, args, budget)
      if (!result.ok) return this.processFailure(result)
      return result.stdout
    }
    // Starting a refresh immediately revokes old patch capabilities, even if refresh fails.
    try {
      if (!project) fail('no-project')
      check()
      if (request.type === 'list') {
        sequence = ++this.listSequence
        this.review = undefined
      }
      if (
        !isAbsolute(project) ||
        (await fs.realpath(project)) !== project ||
        !(await fs.lstat(project)).isDirectory()
      )
        fail('project-unavailable')
      const capability = await this.capability
      check()
      if (!capability.ok) this.processFailure(capability)
      const version = line(capability.stdout).match(/^git version (\d+)\.(\d+)\.(\d+)(?:[\s.]|$)/)
      if (
        !version ||
        Number(version[1]) < 2 ||
        (Number(version[1]) === 2 &&
          (Number(version[2]) < 50 || (Number(version[2]) === 50 && Number(version[3]) < 1)))
      )
        fail('git-version')
      const bare = line(await output(project, ['rev-parse', '--is-bare-repository']))
      if (bare === 'true') fail('bare-repository')
      if (line(await output(project, ['rev-parse', '--is-inside-work-tree'])) !== 'true')
        fail('not-repository')
      const root = await fs.realpath(line(await output(project, ['rev-parse', '--show-toplevel'])))
      const scope = relative(root, project)
      if (scope === '..' || scope.startsWith('../') || isAbsolute(scope))
        fail('project-unavailable')
      // Read names only: do not retrieve, log or expose filter command values.
      const filters = await run(root, [
        'config',
        '--name-only',
        '--get-regexp',
        '^filter\..*\.(clean|process)$'
      ])
      if (
        filters.ok ? filters.stdout.length > 0 : filters.reason !== 'exit' || filters.exitCode !== 1
      ) {
        if (!filters.ok) this.processFailure(filters)
        fail('filters-unsupported')
      }
      let result: GitReviewResult
      if (request.type === 'refs') {
        const text = line(
          await output(root, [
            'for-each-ref',
            '--format=%(refname)',
            '--sort=refname',
            '--count=1001',
            'refs/heads/',
            'refs/remotes/'
          ])
        )
        const names = text ? text.split('\n') : []
        if (names.length > 1000) fail('output-limit')
        if (names.some((name) => !gitReviewRefSchema.safeParse(name).success))
          fail('unsupported-inventory')
        result = {
          type: 'refs',
          refs: names.map((name) => ({ name, label: name.replace(/^refs\/(heads|remotes)\//, '') }))
        }
      } else if (request.type === 'list') {
        const review: Review = {
          id: randomUUID(),
          root,
          scope,
          view: request.view,
          entries: new Map()
        }
        if (request.view === 'branch') {
          if (!request.baseRef) fail('select-base')
          const base = await run(root, [
            'rev-parse',
            '--verify',
            '--end-of-options',
            `${request.baseRef}^{commit}`
          ])
          if (!base.ok) {
            if (base.reason !== 'exit') this.processFailure(base)
            fail('invalid-base')
          }
          const head = await run(root, [
            'rev-parse',
            '--verify',
            '--end-of-options',
            'HEAD^{commit}'
          ])
          if (!head.ok) {
            if (head.reason !== 'exit') this.processFailure(head)
            fail('unborn')
          }
          const baseOid = oid(line(base.stdout))
          const headOid = oid(line(head.stdout))
          const merge = await run(root, ['merge-base', '--all', baseOid, headOid])
          if (!merge.ok) {
            if (merge.reason === 'exit' && merge.exitCode === 1) fail('no-common-ancestor')
            this.processFailure(merge)
          }
          const bases = line(merge.stdout).split('\n').map(oid)
          if (bases.length !== 1) fail('multiple-merge-bases')
          review.branch = { baseRef: request.baseRef, baseOid, headOid, mergeBaseOid: bases[0] }
          const rawModes = parseGitRaw(
            await output(root, [
              'diff',
              ...diffFlags,
              '--raw',
              '-z',
              '--no-abbrev',
              bases[0],
              headOid,
              '--',
              scope || '.'
            ])
          )
          checkInventory(rawModes.length)
          const modes = new Map(rawModes.map((item) => [item.path, item]))
          const names = parseGitNameStatus(
            await output(root, [
              'diff',
              ...diffFlags,
              '--name-status',
              '-z',
              bases[0],
              headOid,
              '--',
              scope || '.'
            ])
          )
          checkInventory(names.length)
          for (const item of names) {
            check()
            const path = this.projectPath(item.path, scope)
            if (path === null) continue
            const mode = modes.get(item.path)
            if (!mode || mode.status !== item.status) fail('unsupported-inventory')
            const dto: GitReviewEntry = {
              entryId: randomUUID(),
              path,
              status: item.status,
              kind: [mode.oldMode, mode.newMode].includes('160000')
                ? 'submodule'
                : [mode.oldMode, mode.newMode].includes('120000')
                  ? 'symlink'
                  : 'tracked'
            }
            review.entries.set(dto.entryId, { path: item.path, dto })
          }
        } else {
          const status = parseGitStatus(
            await output(root, [
              'status',
              '--porcelain=v2',
              '-z',
              '--untracked-files=all',
              '--ignore-submodules=all',
              '--no-renames',
              '--',
              scope || '.'
            ])
          )
          checkInventory(status.length)
          for (const item of status) {
            check()
            const path = this.projectPath(item.path, scope)
            if (path === null) continue
            if (item.kind === 'untracked' && request.view !== 'unstaged') continue
            if (
              item.kind !== 'untracked' &&
              item.kind !== 'conflict' &&
              (request.view === 'staged' ? item.indexStatus : item.worktreeStatus) === '.'
            )
              continue
            const modes =
              item.kind === 'tracked'
                ? request.view === 'staged'
                  ? [item.headMode, item.indexMode]
                  : [item.indexMode, item.worktreeMode]
                : []
            const dto: GitReviewEntry = {
              entryId: randomUUID(),
              path,
              status:
                item.kind === 'untracked'
                  ? '?'
                  : request.view === 'staged'
                    ? item.indexStatus
                    : item.worktreeStatus,
              kind:
                item.kind === 'tracked'
                  ? modes.includes('160000')
                    ? 'submodule'
                    : modes.includes('120000')
                      ? 'symlink'
                      : 'tracked'
                  : item.kind,
              ...(item.kind !== 'untracked'
                ? { indexStatus: item.indexStatus, worktreeStatus: item.worktreeStatus }
                : {})
            }
            if (item.kind === 'untracked') {
              if (item.directory)
                dto.previewUnavailable = '嵌套仓库目录暂不支持文件预览，请单独打开'
              else if (await this.canPreview(project, path, check)) dto.previewPath = path
              else dto.previewUnavailable = '此文件名或类型暂不支持 Files 预览'
            }
            review.entries.set(dto.entryId, { path: item.path, dto })
          }
          // Porcelain --ignore-submodules=all also hides changed gitlinks. The
          // dirty policy restores commit metadata without diffing submodule files.
          {
            const raw = parseGitRaw(
              await output(root, [
                'diff',
                ...diffFlags,
                ...(request.view === 'staged' ? ['--cached'] : []),
                '--raw',
                '-z',
                '--no-abbrev',
                '--',
                scope || '.'
              ])
            )
            checkInventory(raw.length)
            for (const item of raw) {
              check()
              if (![item.oldMode, item.newMode].includes('160000')) continue
              const path = this.projectPath(item.path, scope)
              if (path === null || [...review.entries.values()].some((e) => e.path === item.path))
                continue
              const dto: GitReviewEntry = {
                entryId: randomUUID(),
                path,
                status: item.status,
                kind: 'submodule',
                ...(request.view === 'staged'
                  ? { indexStatus: item.status }
                  : { worktreeStatus: item.status })
              }
              review.entries.set(dto.entryId, { path: item.path, dto })
              checkInventory(review.entries.size)
            }
          }
        }
        check()
        if (sequence !== this.listSequence) fail('stale-review')
        this.review = review
        result = {
          type: 'list',
          reviewId: review.id,
          view: review.view,
          entries: [...review.entries.values()].map((e) => e.dto),
          ...(review.branch ? { branch: review.branch } : {})
        }
      } else {
        const review = this.review
        if (
          !review ||
          review.id !== request.reviewId ||
          review.root !== root ||
          review.scope !== scope
        )
          fail('stale-review')
        const entry = review.entries.get(request.entryId)
        if (!entry) fail('stale-review')
        const common = { type: 'patch' as const, reviewId: review.id, entryId: entry.dto.entryId }
        if (entry.dto.kind === 'conflict')
          result = {
            ...common,
            kind: 'conflict',
            message: '此文件存在合并冲突，暂不提供普通双向差异'
          }
        else if (entry.dto.kind === 'submodule')
          result = {
            ...common,
            kind: 'submodule',
            message: '子模块提交发生变化，请单独打开子模块查看'
          }
        else if (entry.dto.kind === 'untracked')
          result = {
            ...common,
            kind: 'untracked',
            message:
              entry.dto.previewUnavailable ?? '未跟踪文件不属于 Git 差异，可使用只读文件预览',
            ...(entry.dto.previewPath ? { previewPath: entry.dto.previewPath } : {})
          }
        else {
          const comparison =
            review.view === 'staged'
              ? ['--cached']
              : review.branch
                ? [review.branch.mergeBaseOid, review.branch.headOid]
                : []
          // A literal file pathspec can become recursive if the index changes to a
          // directory. Recheck machine inventory, never authorize from patch headers.
          const current = parseGitRaw(
            await output(root, [
              'diff',
              ...diffFlags,
              '--raw',
              '-z',
              '--no-abbrev',
              ...comparison,
              '--',
              entry.path
            ])
          )
          if (
            current.some((item) => {
              const kind = [item.oldMode, item.newMode].includes('160000')
                ? 'submodule'
                : [item.oldMode, item.newMode].includes('120000')
                  ? 'symlink'
                  : 'tracked'
              return (
                item.path !== entry.path ||
                item.status === 'U' ||
                kind !== entry.dto.kind ||
                (item.status === 'T' && entry.dto.status !== 'T')
              )
            })
          )
            fail('stale-review')
          const bytes = await output(
            root,
            [
              'diff',
              ...diffFlags,
              '--unified=3',
              '--src-prefix=a/',
              '--dst-prefix=b/',
              ...comparison,
              '--',
              entry.path
            ],
            'patch'
          )
          let text: string
          let rawOnly = false
          try {
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
          } catch {
            // Bounded byte escaping preserves data instead of silently replacing invalid UTF-8.
            // The expanded serializable result remains bounded by the same patch budget.
            const escaped: string[] = []
            let size = 0
            for (const byte of bytes) {
              const part =
                byte === 92
                  ? '\\\\'
                  : byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)
                    ? String.fromCharCode(byte)
                    : `\\x${byte.toString(16).padStart(2, '0')}`
              if ((size += part.length) > 2 * 1024 * 1024) fail('output-limit')
              escaped.push(part)
            }
            text = escaped.join('')
            rawOnly = true
          }
          const kind = /^Binary files .* differ$/m.test(text)
            ? 'binary'
            : !text
              ? 'empty'
              : !/^@@/m.test(text) &&
                  /^(old mode|new mode|new file mode|deleted file mode) /m.test(text)
                ? 'type-only'
                : 'text'
          result = {
            ...common,
            kind,
            ...(kind === 'text' || kind === 'type-only' ? { text } : {}),
            ...(rawOnly ? { rawOnly: true } : {}),
            message:
              kind === 'binary'
                ? '二进制文件内容发生变化'
                : kind === 'empty'
                  ? '当前没有文本差异'
                  : kind === 'type-only'
                    ? '文件类型或权限变化，无文本差异'
                    : rawOnly
                      ? '非 UTF-8 文本，以字节转义显示原始差异'
                      : ''
          }
        }
        if (this.review !== review) fail('stale-review')
      }
      check()
      return result
    } catch (error) {
      const reason =
        epoch !== this.epoch || (project && this.project !== request.projectPath)
          ? 'project-changed'
          : error instanceof ReviewFailure
            ? error.reason
            : error instanceof GitInventoryError
              ? 'unsupported-inventory'
              : 'project-unavailable'
      return { type: 'unavailable', reason, message: messages[reason] }
    } finally {
      this.controllers.delete(controller)
    }
  }
  private projectPath(path: string, scope: string): string | null {
    validateGitInventoryPath(path)
    if (scope && !path.startsWith(`${scope}/`)) return null
    const result = scope ? path.slice(scope.length + 1) : path
    validateGitInventoryPath(result)
    return result
  }
  private async canPreview(project: string, path: string, check: () => void): Promise<boolean> {
    check()
    if (
      !workspaceFilesCommandSchema.safeParse({ type: 'read', projectPath: project, path }).success
    )
      return false
    let target = project
    let regularFile = false
    try {
      for (const part of path.split('/')) {
        check()
        if (part.toLowerCase() === '.git') return false
        target = join(target, part)
        const info = await fs.lstat(target)
        check()
        if (info.isSymbolicLink()) return false
        regularFile = info.isFile()
      }
      return regularFile
    } catch (error) {
      check()
      if (error instanceof ReviewFailure) throw error
      return false
    }
  }
  private processFailure(result: Extract<GitProcessResult, { ok: false }>): never {
    if (result.stderrKind === 'not-repository') fail('not-repository')
    if (result.reason === 'spawn') fail('git-unavailable')
    if (result.reason === 'timeout' || result.reason === 'aborted') fail(result.reason)
    if (result.reason === 'stdout-limit' || result.reason === 'stderr-limit') fail('output-limit')
    if (result.reason === 'queue-full') fail('busy')
    return fail('git-failed')
  }
}
