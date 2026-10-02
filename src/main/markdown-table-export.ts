import { lstat, open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { serializeMarkdownTable, type MarkdownTableResult } from '../shared/markdown-table-export'
import { t } from '../shared/i18n'

type Owner = { id: number; isDestroyed: () => boolean }
type Dialog = (owner: Owner) => Promise<{ canceled: boolean; filePath?: string }>
const failed = (): MarkdownTableResult => ({
  status: 'failed',
  message: t('保存失败，文件可能已更改，请重新选择保存位置。')
})
export class MarkdownTableExporter {
  private active = new Set<number>()
  constructor(private readonly dialog: Dialog) {}
  async export(owner: Owner, value: unknown): Promise<MarkdownTableResult> {
    let text: string
    try {
      text = serializeMarkdownTable(value).text
    } catch {
      return { status: 'failed', message: t('表格格式无效或超过导出上限。') }
    }
    if (owner.isDestroyed() || this.active.has(owner.id) || this.active.size >= 4) return failed()
    this.active.add(owner.id)
    let temp: string | undefined
    try {
      const selected = await this.dialog(owner)
      if (selected.canceled) return { status: 'cancelled' }
      if (owner.isDestroyed() || !selected.filePath) return failed()
      const target = selected.filePath
      const stat = async (): Promise<string | null> => {
        try {
          const info = await lstat(target)
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('invalid target')
          return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }
      }
      const before = await stat()
      const candidate = join(dirname(target), '.pi-table-' + randomUUID() + '.tmp')
      const handle = await open(candidate, 'wx', 0o600)
      temp = candidate
      try {
        await handle.writeFile(text, 'utf8')
      } finally {
        await handle.close()
      }
      if (owner.isDestroyed() || before !== (await stat())) return failed()
      await rename(temp, target)
      temp = undefined
      return { status: 'saved' }
    } catch {
      return failed()
    } finally {
      if (temp) await unlink(temp).catch(() => undefined)
      this.active.delete(owner.id)
    }
  }
}
