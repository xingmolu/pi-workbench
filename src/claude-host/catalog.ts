import { listSessions } from '@anthropic-ai/claude-agent-sdk'
import { basename, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import type { ProjectCatalog, ProjectCatalogCommand } from '../shared/project-catalog'
import {
  comparePinned,
  projectDisplayName,
  projectIsHidden,
  sessionIsArchived
} from '../shared/navigation-library'
import type { ClaudeSessionStore } from './storage'

/** Discovery is read-only and uses native SDK metadata plus desktop-owned references. */
export async function readClaudeCatalog(
  store: ClaudeSessionStore,
  options: Omit<ProjectCatalogCommand, 'type'> & {
    activeId?: string | null
    activeCwd?: string
    unpaged?: boolean
  }
): Promise<ProjectCatalog> {
  const refs = await store.refs()
  const paths = options.cwd
    ? [resolve(options.cwd)]
    : [
        ...new Set([
          ...refs.map((ref) => ref.cwd),
          ...(options.recentPaths ?? []),
          ...(options.activeCwd ? [options.activeCwd] : [])
        ])
      ]
  const visible = paths
    .filter((path) => options.includeHidden || !projectIsHidden(options.navigation, path))
    .sort((a, b) => comparePinned(options.navigation?.projects[a], options.navigation?.projects[b]))
  const projects = await Promise.all(
    (options.unpaged ? visible : visible.slice(0, 100)).map(async (path) => {
      const available = await stat(path).then(
        (info) => info.isDirectory(),
        () => false
      )
      const native = await listSessions({ dir: path })
      const sessions = (await store.summaries(native, path, options.activeId ?? null))
        .filter(
          (session) =>
            options.includeArchived || !sessionIsArchived(options.navigation, session.path)
        )
        .sort(
          (a, b) =>
            comparePinned(
              options.navigation?.sessions[a.path],
              options.navigation?.sessions[b.path]
            ) || b.modified.localeCompare(a.modified)
        )
      const offset = options.unpaged ? 0 : (options.offset ?? 0)
      const end = options.unpaged ? sessions.length : offset + 50
      return {
        path,
        name: projectDisplayName(options.navigation, path, basename(path)),
        sessions: sessions.slice(offset, end),
        totalSessions: sessions.length,
        nextOffset: end < sessions.length ? end : null,
        ...(!available ? { error: 'directory-unavailable' as const } : {})
      }
    })
  )
  return {
    projects,
    totalProjects: visible.length,
    truncated: !options.unpaged && visible.length > 100
  }
}
