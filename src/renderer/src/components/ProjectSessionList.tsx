import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, GitFork, Plus, Search, X } from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import type {
  CatalogProject,
  ProjectCatalog,
  ProjectNavigationFailures
} from '../../../shared/project-catalog'
import { projectNavigationReason, withLiveProject } from '../../../shared/project-catalog'
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
  onNavigate: (cwd: string, sessionPath?: string) => void
  navigationFailures?: ProjectNavigationFailures
  pending?: boolean
  disabledReason?: string | null
}): React.JSX.Element {
  const [catalog, setCatalog] = useState<ProjectCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [loadingGroups, setLoadingGroups] = useState<string[]>([])
  const [groupErrors, setGroupErrors] = useState<Record<string, string>>({})
  const epoch = useRef(0)
  const search = useRef<HTMLInputElement>(null)
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

  const loadGroup = async (project: CatalogProject, more: boolean): Promise<void> => {
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
  const term = query.trim().toLocaleLowerCase()
  const projects = catalog?.projects.map((project) => withLiveProject(project, snapshot)) ?? []
  const loaded = projects.reduce((total, project) => total + project.sessions.length, 0)
  return (
    <section
      className="project-session-list"
      aria-label="项目会话目录"
      aria-busy={pending || undefined}
    >
      <div className="session-search">
        <Search size={13} aria-hidden="true" />
        <input
          ref={search}
          aria-label="搜索会话标题"
          placeholder="搜索已加载会话"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button
            type="button"
            aria-label="清除搜索"
            onClick={() => {
              setQuery('')
              search.current?.focus()
            }}
          >
            <X size={13} />
          </button>
        )}
      </div>
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
        {projects
          .filter(
            (project) =>
              !term ||
              navigationFailures[project.path] ||
              project.nextOffset !== null ||
              project.sessions.some((session) => session.title.toLocaleLowerCase().includes(term))
          )
          .map((project) => {
            const matching = project.sessions.filter((session) =>
              session.title.toLocaleLowerCase().includes(term)
            )
            const expanded = term.length > 0 || !collapsed.includes(project.path)
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
                      const status = sessionStatusDisplay(session.status)
                      const emphasize = ['running', 'awaiting-approval', 'error'].includes(
                        session.status
                      )
                      return (
                        <button
                          type="button"
                          key={session.path}
                          className={`session-row project-session-row${session.active ? ' is-active' : ''}`}
                          aria-current={session.active ? 'page' : undefined}
                          title={blocked ?? session.title}
                          disabled={Boolean(blocked)}
                          data-navigation-pending={pendingOnly || undefined}
                          onClick={() => onNavigate(project.path, session.path)}
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
                          <time dateTime={session.modified}>{relativeTime(session.modified)}</time>
                        </button>
                      )
                    })}
                    {!matching.length && (
                      <p className="project-group-empty">
                        {term ? '已加载会话中无匹配' : '暂无会话'}
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
        {!loading &&
          catalog &&
          term &&
          !projects.some((project) =>
            project.sessions.some((session) => session.title.toLocaleLowerCase().includes(term))
          ) && (
            <p className="sidebar-empty" role="status">
              没有匹配的会话标题（仅搜索已加载会话）
            </p>
          )}
        {catalog?.truncated && (
          <p className="catalog-scope">
            显示 100 / {catalog.totalProjects} 个项目。使用“添加项目”打开其余项目。
          </p>
        )}
        {term && <p className="catalog-scope">仅搜索已加载标题；可展开项目并显示更多。</p>}
      </div>
    </section>
  )
}
