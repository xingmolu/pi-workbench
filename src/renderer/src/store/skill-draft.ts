import { create } from 'zustand'
import type { AgentSnapshot } from '../../../shared/contracts'
import { safeSkillName, type SkillSummary } from '../../../shared/skills'

export type SkillDraftIdentity = { project: string; sessionId: string; generation: number }
export type SkillInsertion = {
  identity: SkillDraftIdentity
  skill: SkillSummary
  queryPrefix?: string
}
export function skillSlashQuery(draft: string): { query: string; prefix: string } | null {
  if (!draft.startsWith('/') || /^\/skill:[a-z0-9]+(?:-[a-z0-9]+)*\s/.test(draft)) return null
  const token = draft.split(/\s/, 1)[0]
  return {
    query: token.startsWith('/skill:') ? token.slice(7) : token.slice(1),
    prefix: token + (/\s/.test(draft[token.length] ?? '') ? draft[token.length] : '')
  }
}
export function skillDraftIdentity(snapshot: AgentSnapshot): SkillDraftIdentity | null {
  return snapshot.project && snapshot.sessionId
    ? {
        project: snapshot.project.path,
        sessionId: snapshot.sessionId,
        generation: snapshot.generation
      }
    : null
}
export function matchesSkillIdentity(
  a: SkillDraftIdentity | null,
  b: SkillDraftIdentity | null
): boolean {
  return Boolean(
    a &&
    b &&
    a.project === b.project &&
    a.sessionId === b.sessionId &&
    a.generation === b.generation
  )
}
export function insertSkillDraft(
  draft: string,
  request: SkillInsertion,
  current: SkillDraftIdentity | null
): string | null {
  if (
    !matchesSkillIdentity(request.identity, current) ||
    !request.skill.canInsert ||
    !safeSkillName(request.skill.name)
  )
    return null
  if (request.queryPrefix && skillSlashQuery(draft)?.prefix !== request.queryPrefix) return null
  return `/skill:${request.skill.name} ${request.queryPrefix ? draft.slice(request.queryPrefix.length) : draft}`
}
// One-shot intent only. Conversation retains ownership of its versioned per-session drafts.
export const useSkillInsertion = create<{
  pending: SkillInsertion | null
  request: (request: SkillInsertion) => void
  consume: () => SkillInsertion | null
}>((set, get) => ({
  pending: null,
  request: (pending) => set({ pending }),
  consume: () => {
    const pending = get().pending
    set({ pending: null })
    return pending
  }
}))
