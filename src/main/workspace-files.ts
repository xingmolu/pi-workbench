import fs from 'node:fs/promises'
import { constants, type Dirent } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  workspaceFilesCommandSchema,
  type WorkspaceFileEntry,
  type WorkspaceFilesResult
} from '../shared/workspace-files'
import { t } from '../shared/i18n'

const MAX_BYTES = 1024 * 1024
const SEARCH_IGNORED = new Set(['node_modules', 'dist', 'out', '.git'])
const nameOrder = new Intl.Collator('zh-CN', { numeric: true })
class WorkspaceError extends Error {}
const fail = (message: string): never => {
  throw new WorkspaceError(message)
}
const compare = (a: WorkspaceFileEntry, b: WorkspaceFileEntry): number =>
  Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
  nameOrder.compare(a.name, b.name) ||
  (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
const entry = (parent: string, item: Dirent): WorkspaceFileEntry => ({
  name: item.name,
  path: parent ? `${parent}/${item.name}` : item.name,
  kind: item.isSymbolicLink()
    ? 'symlink'
    : item.isDirectory()
      ? 'directory'
      : item.isFile()
        ? 'file'
        : 'other'
})
const visible = (name: string, hidden = false): boolean =>
  name.toLowerCase() !== '.git' && (hidden || !name.startsWith('.'))

/** Main owns authority. This is not an OS sandbox against hostile local directory swaps. */
export class WorkspaceFiles {
  private projectPath: string | null = null
  private epoch = 0

  setProject(path: string | null): void {
    if (path !== this.projectPath) {
      this.projectPath = path
      this.epoch += 1
    }
  }

  async dispatch(command: unknown): Promise<WorkspaceFilesResult> {
    const parsed = workspaceFilesCommandSchema.safeParse(command)
    if (!parsed.success) return fail(t('无效的工作区文件请求'))
    const request = parsed.data
    const project = this.projectPath
    const epoch = this.epoch
    if (!project) return fail(t('尚未打开项目'))
    const check = (): void => {
      if (this.epoch !== epoch || this.projectPath !== request.projectPath)
        fail(t('项目已切换，请重试'))
    }
    check()
    try {
      if (!isAbsolute(project) || (await fs.realpath(project)) !== project)
        fail(t('项目目录不可用，请重新打开项目'))
      const rootInfo = await fs.lstat(project)
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
        fail(t('项目目录不可用，请重新打开项目'))
      let result: WorkspaceFilesResult
      switch (request.type) {
        case 'list':
          result = await this.list(project, request.path, request.includeHidden)
          break
        case 'read':
          result = await this.read(project, request.path)
          break
        case 'search':
          result = await this.search(project, request.query, request.includeHidden, check)
          break
      }
      check()
      return result
    } catch (error) {
      check()
      if (error instanceof WorkspaceError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return fail(t('文件不存在或已被移动'))
      if (code === 'EACCES' || code === 'EPERM') return fail(t('没有权限访问此文件'))
      if (code === 'ELOOP') return fail(t('不支持访问符号链接'))
      return fail(t('无法读取工作区文件，请重试'))
    }
  }

  private async validate(root: string, path: string): Promise<string> {
    let target = root
    for (const segment of path ? path.split('/') : []) {
      if (segment.toLowerCase() === '.git') fail(t('不支持访问 Git 内部文件'))
      target = join(target, segment)
      if ((await fs.lstat(target)).isSymbolicLink()) fail(t('不支持访问符号链接'))
    }
    return target
  }

  private async list(root: string, path: string, hidden?: boolean): Promise<WorkspaceFilesResult> {
    const target = await this.validate(root, path)
    const entries: WorkspaceFileEntry[] = []
    let truncated = false
    let visited = 0
    const directory = await fs.opendir(target)
    for await (const item of directory) {
      // Also bound scanning when a directory contains mostly hidden entries.
      if (++visited > 5000) {
        truncated = true
        break
      }
      if (!visible(item.name, hidden)) continue
      if (entries.length === 1000) {
        truncated = true
        break
      }
      entries.push(entry(path, item))
    }
    entries.sort(compare)
    return { type: 'list', entries, truncated }
  }

  private async read(root: string, path: string): Promise<WorkspaceFilesResult> {
    const target = await this.validate(root, path)
    if (!(await fs.lstat(target)).isFile()) fail(t('只能预览普通文件'))
    const handle = await fs.open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      const info = await handle.stat()
      if (!info.isFile()) fail(t('只能预览普通文件'))
      if (info.size > MAX_BYTES) fail(t('文件超过 1 MiB，无法预览'))
      const buffer = Buffer.alloc(MAX_BYTES + 1)
      let size = 0
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
        if (!bytesRead) break
        size += bytesRead
      }
      if (size > MAX_BYTES) fail(t('文件超过 1 MiB，无法预览'))
      const bytes = buffer.subarray(0, size)
      if (bytes.includes(0)) fail(t('二进制文件无法预览'))
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        return fail(t('二进制文件或非 UTF-8 文本无法预览'))
      }
      return { type: 'read', path, text, size }
    } finally {
      await handle.close()
    }
  }

  private async search(
    root: string,
    query: string,
    hidden: boolean | undefined,
    check: () => void
  ): Promise<WorkspaceFilesResult> {
    const entries: WorkspaceFileEntry[] = []
    let visited = 0
    let truncated = false
    let stopped = false
    const needle = query.toLowerCase()
    const walk = async (path: string, depth: number): Promise<void> => {
      check()
      const target = await this.validate(root, path)
      const directory = await fs.opendir(target)
      for await (const item of directory) {
        check()
        if (++visited > 5000) {
          truncated = true
          stopped = true
          break
        }
        if (!visible(item.name, hidden) || item.isSymbolicLink()) continue
        const value = entry(path, item)
        if (item.isDirectory()) {
          if (SEARCH_IGNORED.has(item.name.toLowerCase())) continue
          if (depth >= 12) {
            truncated = true
            continue
          }
          await walk(value.path, depth + 1)
          if (stopped) break
        } else if (item.isFile() && item.name.toLowerCase().includes(needle)) {
          if (entries.length === 200) {
            truncated = true
            stopped = true
            break
          }
          entries.push(value)
        }
      }
    }
    await walk('', 0)
    entries.sort(
      (a, b) =>
        nameOrder.compare(a.path, b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    )
    return { type: 'search', entries, truncated }
  }
}
