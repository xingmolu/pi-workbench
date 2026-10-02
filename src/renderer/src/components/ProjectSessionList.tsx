import ProjectHeader from './navigation/ProjectHeader'
import SessionNavigationRow from './navigation/SessionNavigationRow'
import { useNavigationLibrary } from '../store/navigation-library'
import { presentNavigationProjects } from '../store/navigation-presentation'
import { useEffect, useRef, useState } from 'react'
import { GitFork } from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import type { ProjectCatalog, ProjectNavigationFailures } from '../../../shared/project-catalog'
import { projectNavigationReason } from '../../../shared/project-catalog'
import { liveProjects, type LiveProject } from '../store/live-projects'
import { usePiStore } from '../store/pi-store'
import { sessionStatusDisplay } from '../../../shared/session-presentation'
import { sidebarPathHint, sidebarSessions } from '../store/sidebar-presentation'
import { relativeTime } from './relative-time'
import { t } from '../../../shared/i18n'

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
export default function ProjectSessionList({
  snapshot,
  onNavigate,
  onCatalog,
  navigationFailures = {},
  pending = false,
  disabledReason
}: {
  snapshot: AgentSnapshot
  onNavigate: (cwd: string, sessionPath?: string, workerId?: string, runtimeId?: string) => void
  onCatalog?: (catalog: ProjectCatalog | null) => void
  navigationFailures?: ProjectNavigationFailures
  pending?: boolean
  disabledReason?: string | null
}): React.JSX.Element {
  const library = useNavigationLibrary((state) => state.library)
  const libraryError = useNavigationLibrary((state) => state.error)
  const residents = usePiStore((state) => state.liveSessions)
  const [catalog, setCatalog] = useState<ProjectCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [expandedHistory, setExpandedHistory] = useState<string[]>([])
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
        onCatalog?.(result.catalog)
        setLoading(false)
      })
      .catch(() => {
        if (request !== epoch.current) return
        onCatalog?.(null)
        setError(t('项目目录暂时不可读取'))
        setLoading(false)
      })
    return () => {
      epoch.current++
    }
  }, [snapshot.ready, snapshot.project?.path, historyKey, retry, library.revision, onCatalog])

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
      if (!next) throw new Error(t('项目目录已变化'))
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
        setGroupErrors((errors) => ({ ...errors, [project.path]: t('读取失败，请重试') }))
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
  const navigationReason = blockReason ?? (pending ? t('正在切换会话，请稍候') : null)
  const projects = presentNavigationProjects(liveProjects(catalog, snapshot, residents), library)
  const loaded = projects.reduce((total, project) => total + project.sessions.length, 0)
  return (
    <section
      className="project-session-list"
      aria-label={t('项目会话目录')}
      aria-busy={pending || undefined}
    >
      <div className="catalog-scope">
        <span
          className="catalog-count"
          title={t('已加载 {length} 个项目 · {loaded} 个会话', { length: projects.length, loaded })}
        >
          {t('项目')} <span className="sidebar-count">{projects.length}</span>
        </span>
        <span className="catalog-status" role="status">
          {pending ? t('正在切换会话') : loading && catalog ? t('更新中') : ''}
        </span>
      </div>
      {libraryError && (
        <p className="catalog-error" role="alert">
          {t('项目偏好读取失败：{libraryError}', { libraryError })}
          <button onClick={() => void useNavigationLibrary.getState().hydrate()}>
            {t('重试')}
          </button>
        </p>
      )}
      {blockReason && (
        <p className="catalog-disabled-reason" role="status">
          {blockReason}
        </p>
      )}
      {loading && !catalog && (
        <p className="sidebar-empty" role="status">
          {t('正在读取项目目录…')}
        </p>
      )}
      {error && (
        <p className="catalog-error" role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            {t('重试')}
          </button>
        </p>
      )}
      <div className="project-groups">
        {catalog?.skippedDirectories ? (
          <p className="catalog-error">
            {t('{skippedDirectories} 个会话目录不可读取或含文件链接，已跳过。', {
              skippedDirectories: catalog.skippedDirectories
            })}
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              {t('重试')}
            </button>
          </p>
        ) : null}
        {projects.map((project) => {
          const showHistory = expandedHistory.includes(project.path)
          const matching = sidebarSessions(project.sessions, showHistory)
          const hasHiddenHistory = matching.length < project.sessions.length
          const duplicateName = projects.some(
            (other) => other.path !== project.path && other.name === project.name
          )
          const expanded = !collapsed.includes(project.path)
          const groupLoading = loadingGroups.includes(project.path)
          const blocked = project.error ? t('项目目录不可用，请重试') : navigationReason
          const pendingOnly = pending && !blockReason && !project.error
          return (
            <section
              className={`project-group${snapshot.project?.path === project.path ? ' is-current-project' : ''}`}
              key={project.path}
              data-project-path={project.path}
            >
              <ProjectHeader
                project={project}
                snapshot={snapshot}
                expanded={expanded}
                hint={
                  duplicateName
                    ? sidebarPathHint(
                        project.path,
                        projects
                          .filter((other) => other.name === project.name)
                          .map((other) => other.path)
                      )
                        .split('/')
                        .slice(0, -1)
                        .join('/')
                    : undefined
                }
                blocked={blocked}
                operationReason={disabledReason ?? null}
                pending={pending}
                onToggle={() => toggle(project.path)}
                onNew={() => onNavigate(project.path)}
              />
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
                    {t('重试打开会话')}
                  </button>
                </p>
              )}
              {expanded && (
                <div className="project-group-sessions">
                  {project.error && (
                    <p className="catalog-error">
                      {t('项目目录不可用{value}', { value: ' ' })}
                      <button
                        type="button"
                        disabled={groupLoading}
                        onClick={() => void loadGroup(project, false)}
                      >
                        {t('重试')}
                      </button>
                    </p>
                  )}
                  {matching.map((session) => {
                    const rowBlocked = session.workerId
                      ? (disabledReason ??
                        (pending
                          ? t('正在切换会话，请稍候')
                          : projectNavigationReason(snapshot, true)))
                      : blocked
                    const status = sessionStatusDisplay(session.status)
                    const emphasize = ['running', 'awaiting-approval', 'error'].includes(
                      session.status
                    )
                    return (
                      <SessionNavigationRow
                        key={session.workerId ?? session.path ?? session.id}
                        session={session}
                        cwd={project.path}
                        blocked={rowBlocked}
                      >
                        <button
                          type="button"
                          key={session.workerId ?? session.path ?? session.id}
                          className={`session-row project-session-row${session.active ? ' is-active' : ''}`}
                          aria-current={session.active ? 'page' : undefined}
                          title={rowBlocked ?? session.title}
                          disabled={Boolean(rowBlocked)}
                          data-navigation-pending={pendingOnly || undefined}
                          onClick={() =>
                            onNavigate(
                              project.path,
                              session.path ?? undefined,
                              session.workerId,
                              session.runtimeId
                            )
                          }
                        >
                          <span className="session-title">{session.title}</span>
                          {session.runtimeId && session.runtimeId !== snapshot.runtime?.id ? (
                            <small className="session-runtime-label">
                              {session.runtimeId === 'claude' ? 'Claude' : session.runtimeId}
                            </small>
                          ) : null}
                          {(session.parentSessionPath || session.parentUnavailable) && (
                            <GitFork
                              size={11}
                              className="session-fork-label"
                              aria-label={t('分叉会话')}
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
                          {session.modified && !emphasize && (
                            <time dateTime={session.modified}>
                              {relativeTime(session.modified)}
                            </time>
                          )}
                        </button>
                      </SessionNavigationRow>
                    )
                  })}
                  {!matching.length && <p className="project-group-empty">{t('暂无会话')}</p>}
                  {(hasHiddenHistory || showHistory) && (
                    <button
                      type="button"
                      className="catalog-more catalog-history-toggle"
                      aria-expanded={showHistory}
                      onClick={() =>
                        setExpandedHistory((paths) =>
                          showHistory
                            ? paths.filter((path) => path !== project.path)
                            : [...paths, project.path]
                        )
                      }
                    >
                      {showHistory ? t('收起历史') : t('显示更多历史')}
                    </button>
                  )}
                  {project.nextOffset !== null && !hasHiddenHistory && (
                    <button
                      type="button"
                      className="catalog-more"
                      disabled={groupLoading}
                      onClick={() => void loadGroup(project, true)}
                    >
                      {groupLoading
                        ? t('正在加载…')
                        : t('显示更多 · 已加载 {length} / {totalSessions}', {
                            length: project.sessions.length,
                            totalSessions: project.totalSessions
                          })}
                    </button>
                  )}
                  {groupErrors[project.path] && (
                    <p className="catalog-error" role="alert">
                      {groupErrors[project.path]}{' '}
                      <button
                        type="button"
                        onClick={() => void loadGroup(project, project.nextOffset !== null)}
                      >
                        {t('重试')}
                      </button>
                    </p>
                  )}
                </div>
              )}
            </section>
          )
        })}
        {!loading && catalog && !projects.length && (
          <p className="sidebar-empty">{t('添加项目，开始第一段会话。')}</p>
        )}
        {catalog?.truncated && (
          <p className="catalog-scope">
            {t('显示 {length} / 至少 {totalProjects} 个项目。使用“搜索所有会话”查找其余会话。', {
              length: catalog.projects.length,
              totalProjects: catalog.totalProjects
            })}
          </p>
        )}
      </div>
    </section>
  )
}
