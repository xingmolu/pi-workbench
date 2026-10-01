import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { getSessionMessages, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import type { SessionSummary } from '../shared/contracts'

export type ClaudeStorage = { root: string; config: string; sessions: string; cache: string }
const referenceSchema = z
  .object({
    version: z.literal(1),
    runtimeId: z.literal('claude'),
    nativeSessionId: z.string().uuid(),
    cwd: z.string().min(1),
    created: z.string(),
    title: z.string().optional(),
    /** The account or API connection this session runs on; absent means the default. */
    connection: z.string().max(64).optional(),
    parentSessionPath: z.string().optional()
  })
  .strict()
export type SessionReference = z.infer<typeof referenceSchema>

/** Desktop files are references only. The SDK remains the sole transcript owner. */
export class ClaudeSessionStore {
  constructor(readonly storage: ClaudeStorage) {}
  path(id: string): string {
    z.string().uuid().parse(id)
    return join(this.storage.sessions, `${id}.json`)
  }
  async read(path: string): Promise<SessionReference> {
    const child = relative(this.storage.sessions, path)
    if (
      !isAbsolute(path) ||
      child.startsWith('..') ||
      isAbsolute(child) ||
      !child ||
      child.includes('/')
    )
      throw new Error('Session reference belongs to another runtime')
    return referenceSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  }
  async save(reference: SessionReference): Promise<string> {
    const value = referenceSchema.parse(reference)
    await mkdir(this.storage.sessions, { recursive: true })
    const path = this.path(value.nativeSessionId)
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    await rename(temporary, path)
    return path
  }
  async refs(): Promise<SessionReference[]> {
    const paths = await readdir(this.storage.sessions).catch(() => [])
    const values = await Promise.all(
      paths
        .filter((path) => path.endsWith('.json'))
        .map(async (path) => {
          try {
            return await this.read(join(this.storage.sessions, path))
          } catch {
            return undefined
          }
        })
    )
    return values.filter((value): value is SessionReference => !!value)
  }
  async summaries(
    native: SDKSessionInfo[],
    cwd: string,
    activeId: string | null
  ): Promise<SessionSummary[]> {
    const refs = (await this.refs()).filter((ref) => ref.cwd === cwd)
    const byId = new Map(native.map((session) => [session.sessionId, session]))
    return (
      await Promise.all(
        refs.map(async (ref) => {
          const info = byId.get(ref.nativeSessionId)
          return {
            id: ref.nativeSessionId,
            runtimeId: 'claude',
            path: this.path(ref.nativeSessionId),
            title: (ref.title ?? info?.customTitle ?? info?.summary ?? 'New session').slice(0, 200),
            modified: new Date(info?.lastModified ?? Date.parse(ref.created)).toISOString(),
            messageCount: info
              ? (await getSessionMessages(ref.nativeSessionId, { dir: cwd })).length
              : 0,
            active: ref.nativeSessionId === activeId,
            status: 'idle' as const,
            ...(ref.parentSessionPath ? { parentSessionPath: ref.parentSessionPath } : {})
          }
        })
      )
    ).sort((a, b) => b.modified.localeCompare(a.modified))
  }
}
