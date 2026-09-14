import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, GitFork, Plus } from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import type {
  ProjectCatalog,
  ProjectNavigationFailures
} from '../../../shared/project-catalog'
import { projectNavigationReason } from '../../../shared/project-catalog'
import { liveProjects, type LiveProject } from '../store/live-projects'
import { usePiStore } from '../store/pi-store'
import { sessionStatusDisplay } from '../../../shared/session-presentation'

const COLLAPSED_KEY = 'pi.project-groups.collapsed.v1'
function readCollapsed(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return Array.isArray(value)
      ? value.filter((path): path is string => typeof path === 'string').slice(0, 100)
      : []
  } catch {
    return []
  }
}
function relativeTime(value: string): string {
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86400000))
  return days === 0
    ? '今天'
    : days < 30
      ? `${days}天`
      : new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

export default function ProjectSessionList({
  snapshot,
  onNavigate,
  navigationFailures = {},
  pending = false,
  disabledReason
}: {
  snapshot: AgentSnapshot
  onNavigate: (cwd: string, sessionPath?: string, workerId?: string) => void
  navigationFailures?: ProjectNavigationFailures
  pending?: boolean
  disabledReason?: string | null
}): React.JSX.Element {
  const residents = usePiStore(state => state.liveSessions)
  const [catalog, setCatalog] = useState<ProjectCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [loadingGroups, setLoadingGroups] = useState<string[]>([])
  const [groupErrors, setGroupErrors] = useState<Record<string, string>>({})
  const epoch = useRef(0)
  const historyKey = snapshot.sessions
    .map((session) => `${session.path}:${session.title}:${session.modified}`)
    .join('|')
  useEffect(() => {
    const request = ++epoch.current
    setLoading(true)
    setError(null)
    setLoadingGroups([])
    void window.pi
      .send({ type: 'project:catalog' })
      .then((result) => {
        if (request !== epoch.current) return
        setCatalog(result.catalog)
        setLoading(false)
      })
      .catch(() => {
        if (request !== epoch.current) return
        setError('项目目录暂时不可读取')
        setLoading(false)
      })
    return () => {
      epoch.current++
    }
  }, [snapshot.ready, snapshot.project?.path, historyKey, retry])

  const loadGroup = async (project: LiveProject, more: boolean): Promise<void> => {
    if (loadingGroups.includes(project.path)) return
    const request = epoch.current
    setLoadingGroups((groups) => [...groups, project.path])
    setGroupErrors((errors) => ({ ...errors, [project.path]: '' }))
    try {
      const result = await window.pi.send({
        type: 'project:catalog',
        cwd: project.path,
        offset: more ? (project.nextOffset ?? 0) : 0
      })
      if (request !== epoch.current) return
      const next = result.catalog.projects[0]
      if (!next) throw new Error('项目目录已变化')
      setCatalog((previous) =>
        previous
          ? {
              ...previous,
              projects: previous.projects.map((group) =>
                group.path !== project.path
                  ? group
                  : {
                      ...next,
                      sessions: more
                        ? [
                            ...new Map(
                              [...group.sessions, ...next.sessions].map((session) => [
                                session.path,
                                session
                              ])
                            ).values()
                          ]
                        : next.sessions
                    }
              )
            }
          : previous
      )
    } catch {
      if (request === epoch.current)
        setGroupErrors((errors) => ({ ...errors, [project.path]: '读取失败，请重试' }))
    } finally {
      if (request === epoch.current)
        setLoadingGroups((groups) => groups.filter((path) => path !== project.path))
    }
  }
  const toggle = (path: string): void => {
    setCollapsed((previous) => {
      const next = previous.includes(path)
        ? previous.filter((value) => value !== path)
        : [...previous, path].slice(-100)
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next))
      } catch {
        /* Optional preference. */
      }
      return next
    })
  }
  // Keep native interaction guards; only transient pending gets stable visual styling.
  const blockReason = disabledReason ?? projectNavigationReason(snapshot)
  const navigationReason = blockReason ?? (pending ? '正在切换会话，请稍候' : null)
  const projects = liveProjects(catalog, snapshot, residents)
  const loaded = projects.reduce((total, project) => total + project.sessions.length, 0)
  return (
    <section
      className="project-session-list"
      aria-label="项目会话目录"
      aria-busy={pending || undefined}
    >
      <div className="catalog-scope">
        <span
          className="catalog-count"
          title={`已加载 ${projects.length} 个项目 · ${loaded} 个会话`}
        >
          已加载 {projects.length} 个项目 · {loaded} 个会话
        </span>
        <span className="catalog-status" role="status">
          {pending ? '正在切换会话' : loading && catalog ? '更新中' : ''}
        </span>
      </div>
      {blockReason && (
        <p className="catalog-disabled-reason" role="status">
          {blockReason}
        </p>
      )}
      {loading && !catalog && (
        <p className="sidebar-empty" role="status">
          正在读取项目目录…
        </p>
      )}
      {error && (
        <p className="catalog-error" role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            重试
          </button>
        </p>
      )}
      <div className="project-groups">
        {catalog?.skippedDirectories ? (
          <p className="catalog-error">
            {catalog.skippedDirectories} 个会话目录不可读取或含文件链接，已跳过。
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              重试
            </button>
          </p>
        ) : null}
        {projects.map((project) => {
            const matching = project.sessions
            const expanded = !collapsed.includes(project.path)
            const groupLoading = loadingGroups.includes(project.path)
            const blocked = project.error ? '项目目录不可用，请重试' : navigationReason
            const pendingOnly = pending && !blockReason && !project.error
            return (
              <section
                className="project-group"
                key={project.path}
                data-project-path={project.path}
              >
                <div className="project-group-head">
                  <button
                    type="button"
                    className="project-group-toggle"
                    title={project.path}
                    aria-expanded={expanded}
                    onClick={() => toggle(project.path)}
                  >
                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <Folder size={14} />
                    <span>{project.name}</span>
                  </button>
                  <button
                    type="button"
                    className="project-new icon-btn"
                    title={blocked ?? `在 ${project.name} 中新建会话`}
                    aria-label={`在 ${project.name} 中新建会话`}
                    disabled={Boolean(blocked)}
                    data-navigation-pending={pendingOnly || undefined}
                    onClick={() => onNavigate(project.path)}
                  >
                    <Plus size={14} />
                  </button>
                </div>
                {navigationFailures[project.path] && (
                  <p className="catalog-error" role="alert">
                    {navigationFailures[project.path].message}{' '}
                    <button
                      type="button"
                      disabled={Boolean(navigationReason)}
                      data-navigation-pending={(pending && !blockReason) || undefined}
                      title={navigationReason ?? undefined}
                      onClick={() =>
                        onNavigate(project.path, navigationFailures[project.path].sessionPath)
                      }
                    >
                      重试打开会话
                    </button>
                  </p>
                )}
                {expanded && (
                  <div className="project-group-sessions">
                    {project.error && (
                      <p className="catalog-error">
                        项目目录不可用{' '}
                        <button
                          type="button"
                          disabled={groupLoading}
                          onClick={() => void loadGroup(project, false)}
                        >
                          重试
                        </button>
                      </p>
                    )}
                    {matching.map((session) => {
                      const rowBlocked = session.workerId
                        ? disabledReason ?? (pending ? '正在切换会话，请稍候' : projectNavigationReason(snapshot, true))
                        : blocked
                      const status = sessionStatusDisplay(session.status)
                      const emphasize = ['running', 'awaiting-approval', 'error'].includes(
                        session.status
                      )
                      return (
                        <button
                          type="button"
                          key={session.workerId ?? session.path ?? session.id}
                          className={`session-row project-session-row${session.active ? ' is-active' : ''}`}
                          aria-current={session.active ? 'page' : undefined}
                          title={rowBlocked ?? session.title}
                          disabled={Boolean(rowBlocked)}
                          data-navigation-pending={pendingOnly || undefined}
                          onClick={() => onNavigate(project.path, session.path ?? undefined, session.workerId)}
                        >
                          <span className="session-title">{session.title}</span>
                          {(session.parentSessionPath || session.parentUnavailable) && (
                            <GitFork
                              size={11}
                              className="session-fork-label"
                              aria-label="分叉会话"
                            />
                          )}
                          {emphasize && (
                            <span
                              className={`session-status-label is-${status.tone}`}
                              title={status.label}
                            >
                              {status.label}
                            </span>
                          )}
                          {session.modified && <time dateTime={session.modified}>{relativeTime(session.modified)}</time>}
                        </button>
                      )
                    })}
                    {!matching.length && (
                      <p className="project-group-empty">
                        暂无会话
                      </p>
                    )}
                    {project.nextOffset !== null && (
                      <button
                        type="button"
                        className="catalog-more"
                        disabled={groupLoading}
                        onClick={() => void loadGroup(project, true)}
                      >
                        {groupLoading
                          ? '正在加载…'
                          : `显示更多 · 已加载 ${project.sessions.length} / ${project.totalSessions}`}
                      </button>
                    )}
                    {groupErrors[project.path] && (
                      <p className="catalog-error" role="alert">
                        {groupErrors[project.path]}{' '}
                        <button
                          type="button"
                          onClick={() => void loadGroup(project, project.nextOffset !== null)}
                        >
                          重试
                        </button>
                      </p>
                    )}
                  </div>
                )}
              </section>
            )
          })}
        {!loading && catalog && !projects.length && (
          <p className="sidebar-empty">添加项目，开始第一段会话。</p>
        )}
        {catalog?.truncated && (
          <p className="catalog-scope">
            显示 100 / {catalog.totalProjects} 个项目。使用“搜索所有会话”查找其余会话。
          </p>
        )}
      </div>
    </section>
  )
}
