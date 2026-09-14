import type { AgentSnapshot, SessionSummary } from '../../../shared/contracts'
import type { CatalogProject, ProjectCatalog } from '../../../shared/project-catalog'
import { withLiveProject } from '../../../shared/project-catalog'
import type { LiveSessionSummary } from '../../../shared/session-runtime'

export type LiveSessionRow = Omit<SessionSummary, 'path'> & {
  path: string | null
  workerId?: string
}
export type LiveProject = Omit<CatalogProject, 'sessions'> & { sessions: LiveSessionRow[] }

/** Catalog history and runtime status have different lifetimes. Never invent a file for a draft. */
export function liveProjects(
  catalog: ProjectCatalog | null,
  snapshot: AgentSnapshot,
  residents: LiveSessionSummary[]
): LiveProject[] {
  const projects: LiveProject[] = (catalog?.projects ?? []).map((project) => ({
    ...project,
    sessions: withLiveProject(project, snapshot).sessions.map((session) => ({
      ...session,
      active: project.path === snapshot.project?.path && session.path === snapshot.activeSessionPath
    }))
  }))
  for (const resident of residents) {
    let project = projects.find((project) => project.path === resident.cwd)
    if (!project) {
      project = {
        path: resident.cwd,
        name: resident.cwd.split('/').filter(Boolean).at(-1) ?? resident.cwd,
        sessions: [],
        totalSessions: 0,
        nextOffset: null
      }
      projects.push(project)
    }
    const existing = resident.sessionPath
      ? project.sessions.find((row) => row.path === resident.sessionPath)
      : undefined
    const row: LiveSessionRow = {
      ...existing,
      id: resident.sessionId ?? resident.workerId,
      path: resident.sessionPath,
      title: resident.title || existing?.title || '新会话',
      modified: existing?.modified ?? '',
      messageCount: existing?.messageCount ?? 0,
      workerId: resident.workerId,
      active: resident.selected,
      status: resident.status === 'opening' ? 'idle' : resident.status
    }
    if (existing) Object.assign(existing, row)
    else project.sessions.unshift(row)
  }
  return projects
}
