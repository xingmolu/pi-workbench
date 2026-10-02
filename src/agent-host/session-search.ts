import {
  comparePinned,
  projectDisplayName,
  projectIsHidden,
  sessionIsArchived,
  type NavigationLibraryState
} from '../shared/navigation-library'
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
import { t } from '../shared/i18n'

type SearchOptions = Parameters<typeof discoverProjectSessions>[0] & {
  query: string
  limit: number
  normalize?: (path: string) => Promise<string | null>
  navigation?: NavigationLibraryState
  includeHidden?: boolean
  includeArchived?: boolean
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
    if (!options.includeHidden && projectIsHidden(options.navigation, cwd)) continue
    projects.set(cwd, {
      cwd,
      projectName: projectDisplayName(options.navigation, cwd, basename(cwd) || cwd).slice(0, 200),
      available: canonical !== null
    })
  }
  const term = query.trim().toLocaleLowerCase()
  const matching = [...projects.values()]
    .sort((a, b) =>
      comparePinned(options.navigation?.projects[a.cwd], options.navigation?.projects[b.cwd])
    )
    .filter(
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
  const canonicalPaths = new Map<string, Promise<string | null>>()
  const normalize = options.normalize ?? canonicalProjectDirectory
  for (const session of sessions) {
    if (
      !isAbsolute(session.cwd) ||
      !isAbsolute(session.path) ||
      !Number.isFinite(session.modified.getTime())
    ) {
      skippedEntries++
      continue
    }
    if (!canonicalPaths.has(session.cwd)) canonicalPaths.set(session.cwd, normalize(session.cwd))
    const canonicalCwd = (await canonicalPaths.get(session.cwd)) ?? resolve(session.cwd)
    // The SDK owns session cwd identity; canonicalization is for presentation filtering only.
    const cwd = session.cwd
    if (!options.includeHidden && projectIsHidden(options.navigation, canonicalCwd)) continue
    if (!options.includeArchived && sessionIsArchived(options.navigation, session.path)) continue
    const sourceTitle =
      session.name?.trim() ||
      session.firstMessage?.trim().replace(/\s+/g, ' ').slice(0, 80) ||
      t('新会话')
    const title = sourceTitle.slice(0, 200)
    const item = sessionSearchItemSchema.safeParse({
      id: session.id,
      title,
      sessionPath: session.path,
      cwd,
      projectName: projectDisplayName(options.navigation, canonicalCwd, basename(cwd) || cwd).slice(
        0,
        200
      ),
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
      comparePinned(
        options.navigation?.sessions[a.sessionPath],
        options.navigation?.sessions[b.sessionPath]
      ) ||
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
