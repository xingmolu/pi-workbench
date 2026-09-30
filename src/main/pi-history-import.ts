import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'

async function transcripts(
  root: string
): Promise<Array<{ bucket: string; name: string; path: string }>> {
  const rows: Array<{ bucket: string; name: string; path: string }> = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return rows
    throw error
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl'))
      rows.push({ bucket: '', name: entry.name, path: join(root, entry.name) })
    if (!entry.isDirectory()) continue
    for (const file of await readdir(join(root, entry.name), { withFileTypes: true }))
      if (file.isFile() && file.name.endsWith('.jsonl'))
        rows.push({ bucket: entry.name, name: file.name, path: join(root, entry.name, file.name) })
  }
  return rows
}

export async function legacyPiHistory(root: string) {
  return { location: root, count: (await transcripts(root)).length }
}

/** Deliberate import: native JSONL only; credentials, endpoints and extensions stay untouched. */
export async function importPiHistory(source: string, destination: string) {
  const rows = await transcripts(source)
  const targets = new Map(rows.map((row) => [row.path, join(destination, row.bucket, row.name)]))
  let imported = 0,
    skipped = 0
  for (const row of rows) {
    try {
      const text = await readFile(row.path, 'utf8')
      const lines = text.split('\n')
      const header = JSON.parse(lines[0]) as {
        type?: string
        cwd?: string
        id?: string
        parentSession?: string
      }
      if (header.type !== 'session' || !header.cwd || !isAbsolute(header.cwd) || !header.id) {
        skipped++
        continue
      }
      if (header.parentSession && targets.has(header.parentSession)) {
        header.parentSession = targets.get(header.parentSession)
        lines[0] = JSON.stringify(header)
      }
      await mkdir(join(destination, row.bucket), { recursive: true, mode: 0o700 })
      await writeFile(targets.get(row.path)!, lines.join('\n'), { flag: 'wx', mode: 0o600 })
      imported++
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' || error instanceof SyntaxError)
        skipped++
      else throw error
    }
  }
  return { imported, skipped }
}
