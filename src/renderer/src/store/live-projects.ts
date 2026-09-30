import type { AgentSnapshot, SessionSummary } from '../../../shared/contracts'
import type { CatalogProject, ProjectCatalog } from '../../../shared/project-catalog'
import { withLiveProject } from '../../../shared/project-catalog'
import type { LiveSessionSummary } from '../../../shared/session-runtime'

export type LiveSessionRow = Omit<SessionSummary, 'path'> & {
  path: string | null
  workerId?: string
  pinned?: boolean
  sessionTask?: LiveSessionSummary['sessionTask']
}
export type LiveProject = Omit<CatalogProject, 'sessions'> & { sessions: LiveSessionRow[] }

/** Keep SessionTask children adjacent to their live parent without inventing a persistent tree. */
export function sessionTaskTreeRows(sessions: LiveSessionRow[]): LiveSessionRow[] {
  const children = new Map<string, LiveSessionRow[]>()
  for (const session of sessions) {
    const relation = session.sessionTask
    if (!relation) continue
    const group = children.get(relation.parentWorkerId) ?? []
    group.push(session)
    children.set(relation.parentWorkerId, group)
  }
  for (const group of children.values()) {
    group.sort((left, right) =>
      (left.sessionTask?.createdAt ?? 0) - (right.sessionTask?.createdAt ?? 0)
    )
  }

  const nested = new Set<string>()
  const result: LiveSessionRow[] = []
  for (const session of sessions) {
    if (session.sessionTask) continue
    result.push(session)
    if (!session.workerId) continue
    for (const child of children.get(session.workerId) ?? []) {
      result.push(child)
      if (child.workerId) nested.add(child.workerId)
    }
  }
  for (const session of sessions) {
    if (!session.sessionTask || (session.workerId && nested.has(session.workerId))) continue
    result.push(session)
  }
  return result
}

function liveTitle(resident: LiveSessionSummary, fallback?: string): string {
  const title = resident.title || fallback || '新会话'
  return resident.sessionTask ? `↳ 后台 Agent · ${title}` : title
}

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
        name: resident.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? resident.cwd,
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
      title: liveTitle(resident, existing?.title),
      modified: existing?.modified ?? '',
      messageCount: existing?.messageCount ?? 0,
      workerId: resident.workerId,
      ...(resident.runtimeId ? { runtimeId: resident.runtimeId } : {}),
      active: resident.selected,
      status: resident.status === 'opening' ? 'idle' : resident.status,
      ...(resident.sessionTask ? { sessionTask: resident.sessionTask } : {})
    }
    if (existing) Object.assign(existing, row)
    else project.sessions.unshift(row)
  }
  for (const project of projects) project.sessions = sessionTaskTreeRows(project.sessions)
  return projects
}
