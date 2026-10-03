import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { t } from '../shared/i18n'

export type ZipLimits = { maxEntries: number; maxTotalBytes: number }

export const PLUGIN_ZIP_LIMITS: ZipLimits = { maxEntries: 5_000, maxTotalBytes: 100 * 1024 * 1024 }

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_ENTRY = 0x02014b50
const LOCAL_ENTRY = 0x04034b50

export class ZipError extends Error {}

/**
 * Extracts a plugin archive into `target`, which must be empty. Only regular files and
 * directories are written: names that are absolute or climb out with `..`, symbolic links,
 * encrypted entries and archives past the limits are refused before anything is written.
 * Stored and deflated entries are supported, which is what zip tools produce.
 */
export async function extractZip(
  archivePath: string,
  target: string,
  limits: ZipLimits = PLUGIN_ZIP_LIMITS
): Promise<void> {
  const zip = await readFile(archivePath)
  const entries = readCentralDirectory(zip, limits)
  let total = 0
  const files: { path: string; data: Buffer }[] = []
  const directories = new Set<string>()
  for (const entry of entries) {
    const relativePath = safeRelativePath(entry.name)
    if (entry.name.endsWith('/')) {
      directories.add(relativePath)
      continue
    }
    total += entry.size
    if (total > limits.maxTotalBytes) throw new ZipError(t('压缩包太大'))
    files.push({ path: relativePath, data: readEntry(zip, entry) })
  }
  for (const directory of directories) await mkdir(join(target, directory), { recursive: true })
  for (const file of files) {
    const destination = join(target, file.path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, file.data, { flag: 'wx' })
  }
}

type CentralEntry = {
  name: string
  method: number
  compressedSize: number
  size: number
  localOffset: number
}

function readCentralDirectory(zip: Buffer, limits: ZipLimits): CentralEntry[] {
  // The end record sits in the last 64 KiB + 22 bytes (its comment is at most 64 KiB).
  let end = -1
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65_557); offset--)
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      end = offset
      break
    }
  if (end < 0) throw new ZipError(t('这不是 zip 压缩包'))
  const count = zip.readUInt16LE(end + 10)
  const directoryOffset = zip.readUInt32LE(end + 16)
  if (count === 0xffff || directoryOffset === 0xffffffff)
    throw new ZipError(t('不支持 Zip64 压缩包'))
  if (count > limits.maxEntries) throw new ZipError(t('压缩包里的文件太多'))

  const entries: CentralEntry[] = []
  let offset = directoryOffset
  for (let index = 0; index < count; index++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL_ENTRY)
      throw new ZipError(t('压缩包已损坏'))
    const flags = zip.readUInt16LE(offset + 8)
    const method = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const size = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const madeBy = zip.readUInt16LE(offset + 4) >> 8
    const externalAttributes = zip.readUInt32LE(offset + 38)
    const localOffset = zip.readUInt32LE(offset + 42)
    const name = zip.toString(
      flags & 0x800 ? 'utf8' : 'latin1',
      offset + 46,
      offset + 46 + nameLength
    )
    if (flags & 0x1) throw new ZipError(t('不支持加密的压缩包'))
    // Unix-made archives keep the file type in the high bits; 0o120000 is a symbolic link.
    if (madeBy === 3 && ((externalAttributes >>> 16) & 0o170000) === 0o120000)
      throw new ZipError(t('压缩包里不能有符号链接：{name}', { name }))
    if (method !== 0 && method !== 8) throw new ZipError(t('不支持 {name} 的压缩方式', { name }))
    entries.push({ name, method, compressedSize, size, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readEntry(zip: Buffer, entry: CentralEntry): Buffer {
  const offset = entry.localOffset
  if (offset + 30 > zip.length || zip.readUInt32LE(offset) !== LOCAL_ENTRY)
    throw new ZipError(t('压缩包已损坏'))
  const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28)
  const raw = zip.subarray(start, start + entry.compressedSize)
  if (raw.length !== entry.compressedSize) throw new ZipError(t('压缩包已损坏'))
  const data =
    entry.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: entry.size })
  if (data.length !== entry.size) throw new ZipError(t('{name} 的大小不一致', { name: entry.name }))
  return data
}

/** A path inside the extraction directory, or an error for anything that could leave it. */
export function safeRelativePath(name: string): string {
  const unified = name.replace(/\\/g, '/')
  if (!unified || unified.includes('\0') || unified.startsWith('/') || /^[A-Za-z]:/.test(unified))
    throw new ZipError(t('压缩包里的路径不安全：{name}', { name }))
  const parts = unified.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..') || !parts.length)
    throw new ZipError(t('压缩包里的路径不安全：{name}', { name }))
  const relative = normalize(parts.join(sep))
  if (isAbsolute(relative)) throw new ZipError(t('压缩包里的路径不安全：{name}', { name }))
  return relative
}
