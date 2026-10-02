import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import {
  MAX_SKILLS,
  MAX_SKILL_BYTES,
  safeSkillName,
  type SkillIdentity,
  type SkillSummary,
  type SkillsCatalogSnapshot,
  type SkillDetail
} from '../shared/skills'
import { t } from '../shared/i18n'

// The SDK's loaded resource list is the sole authority. Paths never cross IPC.
type LoadedSkill = {
  name: string
  description: string
  filePath: string
  disableModelInvocation: boolean
  sourceInfo: { scope: 'user' | 'project' | 'temporary'; origin: 'package' | 'top-level' }
}
type Context = SkillIdentity & { skills: readonly LoadedSkill[] }
type Entry = { loaded: LoadedSkill; summary: SkillSummary; fingerprint: string | null }
const fingerprint = (s: Stats): string => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
const changed = (): Error =>
  new Error(t('技能文件已更改或不可预览，请刷新列表；重新加载技能需要重新打开项目。'))

export class SkillsCatalog {
  private entries = new Map<string, Entry>()
  private identity: SkillIdentity | null = null
  private revision = 0
  constructor(private readonly current: () => Context | null) {}

  private context(identity: SkillIdentity): Context {
    const current = this.current()
    if (
      !current ||
      current.sessionId !== identity.sessionId ||
      current.generation !== identity.generation
    )
      throw new Error(t('会话已变化，请刷新技能列表。'))
    return current
  }

  async list(identity: SkillIdentity): Promise<SkillsCatalogSnapshot> {
    const current = this.context(identity)
    const revision = ++this.revision
    const counts = new Map<string, number>()
    for (const skill of current.skills) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1)
    const entries = await Promise.all(
      current.skills.slice(0, MAX_SKILLS).map(async (loaded): Promise<Entry> => {
        let signature: string | null = null
        try {
          const info = await stat(loaded.filePath)
          if (info.isFile() && info.size <= MAX_SKILL_BYTES) signature = fingerprint(info)
        } catch {
          /* only allowlisted metadata is returned */
        }
        return {
          loaded,
          fingerprint: signature,
          summary: {
            id: randomUUID(),
            name: loaded.name.slice(0, 128),
            description: loaded.description.slice(0, 1024),
            scope: loaded.sourceInfo.scope,
            origin: loaded.sourceInfo.origin,
            mode: loaded.disableModelInvocation ? 'manual-only' : 'model-and-manual',
            canInsert: safeSkillName(loaded.name) && counts.get(loaded.name) === 1
          }
        }
      })
    )
    this.context(identity)
    if (revision !== this.revision) throw new Error(t('技能列表已更新，请重试。'))
    this.identity = { ...identity }
    this.entries = new Map(entries.map((entry) => [entry.summary.id, entry]))
    return {
      sessionId: identity.sessionId,
      generation: identity.generation,
      skills: entries.map((entry) => entry.summary),
      total: current.skills.length,
      truncated: current.skills.length > MAX_SKILLS
    }
  }

  async detail(request: SkillIdentity & { id: string }): Promise<SkillDetail> {
    const current = this.context(request)
    const entry = this.entries.get(request.id)
    if (
      !entry ||
      this.identity?.sessionId !== request.sessionId ||
      this.identity.generation !== request.generation ||
      !current.skills.includes(entry.loaded)
    )
      throw new Error(t('技能不在当前已加载列表中，请刷新列表。'))
    if (!entry.fingerprint) throw changed()
    const revision = this.revision
    let preview: string
    try {
      // Nonblocking prevents special-file replacements from hanging before fstat.
      const file = await open(entry.loaded.filePath, constants.O_RDONLY | constants.O_NONBLOCK)
      try {
        const before = await file.stat()
        if (
          !before.isFile() ||
          before.size > MAX_SKILL_BYTES ||
          fingerprint(before) !== entry.fingerprint
        )
          throw changed()
        const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (
          bytesRead !== before.size ||
          fingerprint(await file.stat()) !== entry.fingerprint ||
          fingerprint(await stat(entry.loaded.filePath)) !== entry.fingerprint
        )
          throw changed()
        const bytes = buffer.subarray(0, bytesRead)
        preview = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(preview)) throw changed()
      } finally {
        await file.close()
      }
    } catch {
      throw changed()
    }
    const after = this.context(request)
    if (revision !== this.revision || !after.skills.includes(entry.loaded))
      throw new Error(t('技能列表已更新，请重试。'))
    return {
      sessionId: request.sessionId,
      generation: request.generation,
      skill: entry.summary,
      preview
    }
  }
}
