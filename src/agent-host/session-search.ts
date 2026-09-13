import { basename, isAbsolute, resolve } from 'node:path'
import { canonicalProjectDirectory, discoverProjectSessions } from './project-catalog'
import {
  projectSearchCommandSchema,
  projectSearchResultSchema,
  sessionSearchCommandSchema,
  sessionSearchItemSchema,
  type ProjectSearchResult,
  type SessionSearchResult
} from '../shared/session-search'

type SearchOptions = Parameters<typeof discoverProjectSessions>[0] & {
  query: string
  limit: number
  normalize?: (path: string) => Promise<string | null>
}
const compareIdentity = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export async function searchProjects(
  options: SearchOptions & { recentPaths: string[] }
): Promise<ProjectSearchResult> {
  const { query, limit } = projectSearchCommandSchema.parse({
    type: 'project:search',
    query: options.query,
    limit: options.limit
  })
  let skippedDirectories = 0
  let skippedEntries = 0
  const sessions = await discoverProjectSessions({
    ...options,
    onSkippedDirectory: () => skippedDirectories++
  })
  const normalize = options.normalize ?? canonicalProjectDirectory
  const projects = new Map<string, ProjectSearchResult['items'][number]>()
  for (const path of [
    ...new Set([...options.recentPaths, ...sessions.map((session) => session.cwd)])
  ]) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096) {
      skippedEntries++
      continue
    }
    const canonical = await normalize(path)
    const cwd = canonical ?? resolve(path)
    if (cwd.length > 4096) {
      skippedEntries++
      continue
    }
    projects.set(cwd, {
      cwd,
      projectName: (basename(cwd) || cwd).slice(0, 200),
      available: canonical !== null
    })
  }
  const term = query.trim().toLocaleLowerCase()
  const matching = [...projects.values()].filter(
    (project) =>
      project.cwd.toLocaleLowerCase().includes(term) ||
      project.projectName.toLocaleLowerCase().includes(term)
  )
  // Trusted recent order comes first; discovered directories remain reachable by query.
  return projectSearchResultSchema.parse({
    items: matching.slice(0, limit),
    total: matching.length,
    truncated: matching.length > limit,
    skippedDirectories,
    skippedEntries
  })
}

/** Read-only projection over complete SDK discovery, before sidebar paging/caps. */
export async function searchSessions(options: SearchOptions): Promise<SessionSearchResult> {
  const { query, limit } = sessionSearchCommandSchema.parse({
    type: 'session:search',
    query: options.query,
    limit: options.limit
  })
  let skippedDirectories = 0
  let skippedEntries = 0
  const sessions = await discoverProjectSessions({
    ...options,
    onSkippedDirectory: () => skippedDirectories++
  })
  const items = new Map<string, SessionSearchResult['items'][number]>()
  const term = query.trim().toLocaleLowerCase()
  for (const session of sessions) {
    if (
      !isAbsolute(session.cwd) ||
      !isAbsolute(session.path) ||
      !Number.isFinite(session.modified.getTime())
    ) {
      skippedEntries++
      continue
    }
    // Keep the SDK's source cwd; Main revalidates/canonicalizes it when opening.
    const cwd = resolve(session.cwd)
    const sourceTitle =
      session.name?.trim() ||
      session.firstMessage?.trim().replace(/\s+/g, ' ').slice(0, 80) ||
      '新会话'
    const title = sourceTitle.slice(0, 200)
    const item = sessionSearchItemSchema.safeParse({
      id: session.id,
      title,
      sessionPath: session.path,
      cwd,
      projectName: (basename(cwd) || cwd).slice(0, 200),
      modified: session.modified.toISOString()
    })
    if (!item.success) {
      skippedEntries++
      continue
    }
    if (!sourceTitle.toLocaleLowerCase().includes(term)) continue
    items.set(JSON.stringify([cwd, session.path, session.id]), item.data)
  }
  const sorted = [...items.values()].sort(
    (a, b) =>
      Date.parse(b.modified) - Date.parse(a.modified) ||
      compareIdentity(a.cwd, b.cwd) ||
      compareIdentity(a.sessionPath, b.sessionPath) ||
      compareIdentity(a.id, b.id)
  )
  return {
    items: sorted.slice(0, limit),
    total: sorted.length,
    truncated: sorted.length > limit,
    skippedDirectories,
    skippedEntries
  }
}
