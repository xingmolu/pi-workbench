// i18n-ignore-file: loaded directly by Node in SDK tests, so it imports no runtime code from shared/.
import { comparePinned, projectDisplayName, projectIsHidden, sessionIsArchived, type NavigationLibraryState } from '../shared/navigation-library.ts'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import type { ProjectCatalog, ProjectCatalogQuery } from '../shared/project-catalog'

export async function canonicalProjectDirectory(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return null
  try {
    const canonical = await realpath(path)
    return (await stat(canonical)).isDirectory() ? canonical : null
  } catch {
    return null
  }
}

type CatalogOptions = ProjectCatalogQuery & {
  manager: Pick<typeof SessionManager, 'listAll'>
  agentDir: string
  sessionsRoot?: string
  recentPaths: string[]
  navigation?: NavigationLibraryState
  normalize?: (path: string) => Promise<string | null>
  directories?: (path: string) => Promise<string[]>
  onSkippedDirectory?: () => void
}

export async function discoverProjectSessions(
  options: Pick<CatalogOptions, 'manager' | 'agentDir' | 'sessionsRoot' | 'directories' | 'onSkippedDirectory'>
) {
  const root = options.sessionsRoot ?? join(options.agentDir, 'sessions')
  const directories =
    options.directories ??
    (async (path: string) => {
      try {
        if ((await lstat(path)).isSymbolicLink()) throw new Error('会话目录不可为符号链接')
        return (await readdir(path, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(path, entry.name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw new Error('会话目录暂时不可读取，请重试')
      }
    })
  // The public explicit-directory overload is flat. Bucket names are never decoded.
  return (
    await Promise.all(
      [root, ...(await directories(root))].map(async (path) => {
        // listAll follows file symlinks. Skip such a directory before invoking it.
        if (!options.directories) {
          try {
            const entries = await readdir(path,{withFileTypes:true})
            if (entries.some(entry => entry.name.endsWith('.jsonl') && entry.isSymbolicLink())) {
              options.onSkippedDirectory?.()
              return []
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') options.onSkippedDirectory?.()
            return []
          }
        }
        return options.manager.listAll(path)
      })
    )
  ).flat()
}

export async function readProjectCatalog(options: CatalogOptions): Promise<ProjectCatalog> {
  const normalize = options.normalize ?? canonicalProjectDirectory
  let skippedDirectories = 0
  const listed = await discoverProjectSessions({...options,onSkippedDirectory:()=>{skippedDirectories++}})
  const cwdPaths = [
    ...new Set([...options.recentPaths, ...listed.map((session) => session.cwd)])
  ].filter((path) => typeof path === 'string' && isAbsolute(path))
  const canonical = new Map(
    await Promise.all(cwdPaths.map(async (path) => [path, await normalize(path)] as const))
  )
  const projects = new Map<string, { available: boolean; sessions: typeof listed }>()
  for (const path of cwdPaths) {
    const normalized = canonical.get(path)
    const key = normalized ?? resolve(path)
    if (!projects.has(key)) projects.set(key, { available: normalized !== null, sessions: [] })
  }
  for (const session of listed) {
    if (!isAbsolute(session.cwd) || !isAbsolute(session.path)) continue
    projects.get(canonical.get(session.cwd) ?? resolve(session.cwd))?.sessions.push(session)
  }
  const visible = [...projects].filter(([path]) => options.includeHidden || !projectIsHidden(options.navigation, path))
    .sort(([left], [right]) => comparePinned(options.navigation?.projects[left], options.navigation?.projects[right]))
  const requestedCwd = options.cwd
    ? ((await normalize(options.cwd)) ?? resolve(options.cwd))
    : undefined
  return {
    totalProjects: visible.length,
    truncated: !requestedCwd && visible.length > 100,
    ...(skippedDirectories ? {skippedDirectories} : {}),
    projects: visible
      .filter(([path]) => !requestedCwd || path === requestedCwd)
      .slice(0, 100)
      .map(([path, group]) => {
        const sessions = group.sessions
          .filter((session) => options.includeArchived || !sessionIsArchived(options.navigation, session.path))
          .sort((a, b) => comparePinned(options.navigation?.sessions[a.path], options.navigation?.sessions[b.path]) || b.modified.getTime() - a.modified.getTime() || a.path.localeCompare(b.path))
        const offset = options.offset ?? 0
        const end = Math.min(sessions.length, offset + 50)
        return {
          path,
          name: projectDisplayName(options.navigation, path, basename(path) || path),
          totalSessions: sessions.length,
          nextOffset: end < sessions.length ? end : null,
          ...(!group.available ? { error: 'directory-unavailable' as const } : {}),
          sessions: sessions.slice(offset, end).map((session) => ({
            id: session.id,
            path: session.path,
            title:
              session.name?.trim() ||
              session.firstMessage?.trim().replace(/\s+/g, ' ').slice(0, 80) ||
              '新会话',
            modified: session.modified.toISOString(),
            messageCount: session.messageCount,
            active: false,
            status: 'idle' as const,
            ...(session.parentSessionPath
              ? group.sessions.some((parent) => parent.path === session.parentSessionPath)
                ? { parentSessionPath: session.parentSessionPath }
                : { parentUnavailable: true }
              : {})
          }))
        }
      })
  }
}
