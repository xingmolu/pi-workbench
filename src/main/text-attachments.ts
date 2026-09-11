import fs from 'node:fs/promises'
import { constants, type Stats } from 'node:fs'
import { basename, extname, join, parse, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AttachmentScope, TextAttachment, TextSnapshot } from '../shared/text-attachments'

const MAX = 1048576
const TTL = 30 * 60 * 1000
const unsupported = new Set(
  '.pdf .doc .docx .xls .xlsx .ppt .pptx .odt .ods .odp .rtf .zip .gz .tgz .tar .bz2 .xz .7z .rar .png .jpg .jpeg .gif .webp .ico .bmp .tif .tiff .heic .mp3 .mp4 .mov .wav .ogg .woff .woff2 .ttf .otf .exe .dll .dylib .so .wasm .sqlite .db .bin'.split(
    ' '
  )
)
const failure = (message: string): never => {
  throw new Error(message)
}
const identity = (scope: AttachmentScope): string => JSON.stringify(scope)
const same = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs

/** Bounded main-only snapshots; checks local races but is not an OS sandbox. */
export class TextAttachments {
  private context = ''
  private epoch = 0
  private pending = 0
  private entries = new Map<string, { owner: number; snapshot: TextSnapshot; expires: number }>()
  setContext(scope: AttachmentScope | null): void {
    const next = scope ? identity(scope) : ''
    if (next === this.context) return
    this.context = next
    this.epoch++
    this.entries.clear()
  }
  clearOwner(owner: number): void {
    for (const [id, entry] of this.entries) if (entry.owner === owner) this.entries.delete(id)
    this.epoch++
  }
  private check(scope: AttachmentScope, epoch = this.epoch): void {
    if (!this.context || identity(scope) !== this.context || epoch !== this.epoch)
      failure('会话已切换，请重新选择文件')
    for (const [id, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(id)
  }
  lease(scope: AttachmentScope): () => void {
    const epoch = this.epoch
    this.check(scope, epoch)
    return () => this.check(scope, epoch)
  }
  list(owner: number, scope: AttachmentScope): TextAttachment[] {
    this.check(scope)
    return [...this.entries.values()]
      .filter((e) => e.owner === owner)
      .map(({ snapshot: { text: _, ...descriptor } }) => descriptor)
  }
  remove(owner: number, scope: AttachmentScope, id: string): void {
    this.check(scope)
    if (!this.entries.has(id)) return
    if (this.entries.get(id)?.owner !== owner) failure('文件快照已失效')
    this.entries.delete(id)
  }
  capture(owner: number, scope: AttachmentScope, ids: string[]): TextSnapshot[] {
    this.check(scope)
    if (new Set(ids).size !== ids.length || ids.length < 1 || ids.length > 4)
      failure('文件数量无效')
    return ids.map((id) => {
      const entry = this.entries.get(id)
      if (!entry || entry.owner !== owner) return failure('文件快照已移除或过期，请重新选择')
      return { ...entry.snapshot }
    })
  }
  async add(owner: number, scope: AttachmentScope, paths: string[]): Promise<TextAttachment[]> {
    const epoch = this.epoch
    const check = (): void => this.check(scope, epoch)
    check()
    if (!paths.length) return this.list(owner, scope)
    // Single bounded read transaction prevents racing picker/Files calls from
    // each claiming the same count and byte budget.
    if (this.pending) failure('正在读取文件，请稍候')
    if (this.entries.size + paths.length > 4) failure('最多添加 4 个文本文件')
    this.pending++
    try {
      const snapshots: TextSnapshot[] = []
      let total = [...this.entries.values()].reduce((n, e) => n + e.snapshot.size, 0)
      for (const path of paths) {
        const snapshot = await this.read(path, check)
        check()
        total += snapshot.size
        if (total > 2 * MAX) failure('文本文件合计不能超过 2 MiB')
        snapshots.push(snapshot)
      }
      check()
      for (const snapshot of snapshots)
        this.entries.set(snapshot.id, { owner, snapshot, expires: Date.now() + TTL })
      return this.list(owner, scope)
    } catch (error) {
      check()
      if (error instanceof Error && !('code' in error)) throw error
      return failure('无法读取文件，请检查文件是否存在及读取权限')
    } finally {
      this.pending--
    }
  }
  private async read(path: string, check: () => void): Promise<TextSnapshot> {
    const name = basename(path)
    if (unsupported.has(extname(name).toLowerCase()))
      failure('仅支持 UTF-8 文本和源代码文件；不支持 PDF、Office、图片或压缩包')
    const validate = async (): Promise<Stats> => {
      let current = parse(path).root
      for (const segment of resolve(path).slice(current.length).split('/')) {
        current = join(current, segment)
        const info = await fs.lstat(current)
        check()
        if (info.isSymbolicLink()) failure('不支持符号链接文件或目录')
      }
      const real = await fs.realpath(path)
      check()
      if (real !== path) failure('文件路径已变化，请重新选择')
      const info = await fs.lstat(path)
      check()
      if (!info.isFile()) failure('只能添加普通文本文件')
      return info
    }
    const before = await validate()
    check()
    if (before.size > MAX) failure('单个文本文件不能超过 1 MiB')
    const handle = await fs.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      check()
      const opened = await handle.stat()
      check()
      if (!opened.isFile() || !same(before, opened)) failure('文件在读取期间发生变化，请重试')
      const buffer = Buffer.alloc(MAX + 1)
      let size = 0
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
        check()
        if (!bytesRead) break
        size += bytesRead
      }
      const after = await handle.stat()
      check()
      const pathAfter = await validate()
      check()
      if (!same(opened, after) || !same(after, pathAfter) || size !== after.size)
        failure('文件在读取期间发生变化，请重试')
      if (size > MAX) failure('单个文本文件不能超过 1 MiB')
      const bytes = buffer.subarray(0, size)
      if (
        bytes.subarray(0, 5).toString('ascii') === '%PDF-' ||
        (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4)
      )
        failure('不支持 PDF 或压缩格式文件')
      if (bytes.includes(0)) failure('不支持二进制文件')
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      } catch {
        return failure('只支持有效 UTF-8 文本')
      }
      return {
        id: randomUUID(),
        name: name.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '�').slice(0, 255),
        size,
        kind: 'text',
        text
      }
    } finally {
      await handle.close()
    }
  }
}
