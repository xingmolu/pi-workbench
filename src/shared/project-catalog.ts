import type { AgentSnapshot, SessionSummary } from './contracts'

export type ProjectCatalogQuery = { cwd?: string; offset?: number }
export type ProjectNavigationFailures = Record<string, { message: string; sessionPath?: string }>
export type ProjectCatalogCommand = ProjectCatalogQuery & {
  type: 'project:catalog'
  recentPaths?: string[]
}
export type ProjectNavigateCommand = {
  type: 'project:navigate'
  cwd: string
  sessionPath?: string
  sessionId: string | null
  generation: number
}
export type CatalogProject = {
  path: string
  name: string
  sessions: SessionSummary[]
  totalSessions: number
  nextOffset: number | null
  error?: 'directory-unavailable'
}
export type ProjectCatalog = {
  projects: CatalogProject[]
  totalProjects: number
  truncated: boolean
  skippedDirectories?: number
}

/** Live state belongs only to the active cwd. Catalog reads never activate a runtime. */
export function withLiveProject(project: CatalogProject, snapshot: AgentSnapshot): CatalogProject {
  if (project.path !== snapshot.project?.path) return project
  const live = new Map(snapshot.sessions.map((session) => [session.path, session]))
  const sessions = project.sessions.map((session) => live.get(session.path) ?? session)
  const active = snapshot.sessions.find((session) => session.active)
  if (active && !sessions.some((session) => session.path === active.path)) sessions.unshift(active)
  return { ...project, sessions }
}

export function projectNavigationReason(snapshot: AgentSnapshot, residentSelection = false): string | null {
  if (!snapshot.ready && !(residentSelection && snapshot.desktopScope)) return 'Pi 引擎未连接'
  // Only the resident-worker controller grants navigation during execution.
  if (!snapshot.desktopScope && (snapshot.busy || snapshot.queuedCount > 0 || snapshot.approvals.length))
    return '请先停止当前会话'
  if (snapshot.edit?.pending) return '请先完成或取消编辑'
  if (['starting', 'browser', 'device_code', 'waiting'].includes(snapshot.login.phase))
    return '请先完成登录'
  return null
}
