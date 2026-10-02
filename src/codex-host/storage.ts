import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export type CodexStorage = { root: string; config: string; sessions: string; cache: string }

const referenceSchema = z
  .object({
    version: z.literal(1),
    runtimeId: z.literal('codex'),
    /** Desktop identity of the chat; stable before Codex has created its thread. */
    id: z.string().uuid(),
    threadId: z.string().min(1).max(128).optional(),
    cwd: z.string().min(1),
    created: z.string(),
    title: z.string().max(200).optional(),
    /** The ChatGPT account (Pi provider id) this chat runs on. */
    account: z.string().max(128).optional(),
    parentSessionPath: z.string().optional()
  })
  .strict()
export type CodexSessionReference = z.infer<typeof referenceSchema>

/** Desktop files are references only; Codex keeps the transcript in its own home. */
export class CodexSessionStore {
  constructor(readonly storage: CodexStorage) {}

  path(id: string): string {
    z.string().uuid().parse(id)
    return join(this.storage.sessions, `${id}.json`)
  }

  create(cwd: string, account?: string): CodexSessionReference {
    return {
      version: 1,
      runtimeId: 'codex',
      id: randomUUID(),
      cwd,
      created: new Date().toISOString(),
      ...(account ? { account } : {})
    }
  }

  async read(path: string): Promise<CodexSessionReference> {
    const child = relative(this.storage.sessions, path)
    if (
      !isAbsolute(path) ||
      !child ||
      child.startsWith('..') ||
      isAbsolute(child) ||
      child.includes('/')
    )
      throw new Error('Session reference belongs to another runtime')
    return referenceSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  }

  async save(reference: CodexSessionReference): Promise<string> {
    const value = referenceSchema.parse(reference)
    await mkdir(this.storage.sessions, { recursive: true })
    const path = this.path(value.id)
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    await rename(temporary, path)
    return path
  }

  async refs(): Promise<CodexSessionReference[]> {
    const names = await readdir(this.storage.sessions).catch(() => [] as string[])
    const values = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map((name) => this.read(join(this.storage.sessions, name)).catch(() => undefined))
    )
    return values.filter((value): value is CodexSessionReference => !!value)
  }
}
