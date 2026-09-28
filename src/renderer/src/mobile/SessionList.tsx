import { useState } from 'react'
import { ChevronRight, Folder, Plus, RefreshCw, Search } from 'lucide-react'
import {
  filterMobileHomeGroups,
  mobileStatusBadge,
  type MobileHomeGroup,
  type MobileHomeSession
} from '../../../shared/mobile-list'
import { MOBILE_KEEP_AWAKE_COPY, MOBILE_SECURITY_COPY } from '../../../shared/mobile-gateway'
import { ThemeButton } from './ThemeButton'
import type { MobileThemeChoice } from './theme'

const OPEN_KEY = 'pi-mobile-open-projects'
const NOTICE_KEY = 'pi-mobile-notice'

function storedOpen(): Set<string> | null {
  try {
    const raw = localStorage.getItem(OPEN_KEY)
    return raw === null ? null : new Set(JSON.parse(raw) as string[])
  } catch {
    return null
  }
}

const hot = (group: MobileHomeGroup): boolean =>
  group.sessions.some((session) =>
    ['running', 'opening', 'awaiting-approval'].includes(session.status)
  )

export function SessionList({
  groups,
  host,
  error,
  selected,
  theme,
  onTheme,
  onRefresh,
  onOpen,
  onNewSession
}: {
  groups: MobileHomeGroup[]
  host: string
  error: string
  selected: string | null
  theme: MobileThemeChoice
  onTheme: (choice: MobileThemeChoice) => void
  onRefresh: () => Promise<void>
  onOpen: (session: MobileHomeSession) => void
  onNewSession: (cwd: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [open, setOpen] = useState(storedOpen)
  const [notice, setNotice] = useState(() => {
    try {
      return localStorage.getItem(NOTICE_KEY) !== '1'
    } catch {
      return true
    }
  })
  const visible = filterMobileHomeGroups(groups, query)
  const defaults = new Set(
    visible.filter((group, index) => hot(group) || index === 0).map((group) => group.path)
  )
  const isOpen = (path: string): boolean => (open ? open.has(path) : defaults.has(path))
  const toggle = (path: string): void => {
    const next = new Set(open ?? defaults)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setOpen(next)
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...next]))
    } catch {
      /* Only this visit remembers it. */
    }
  }
  const total = visible.reduce((sum, group) => sum + group.sessions.length, 0)
  return (
    <>
      <header className="m-top">
        <h1>远程对话</h1>
        <button
          type="button"
          className="m-icon m-list-search"
          aria-label="搜索"
          aria-pressed={searching}
          onClick={() => setSearching(!searching)}
        >
          <Search size={18} />
        </button>
        <button
          type="button"
          className="m-icon"
          aria-label="刷新"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true)
            void onRefresh().finally(() => setRefreshing(false))
          }}
        >
          <RefreshCw size={18} className={refreshing ? 'm-spin' : undefined} />
        </button>
        <ThemeButton choice={theme} onChoice={onTheme} />
      </header>
      <div className="m-connect">
        <span className="m-live-dot" />
        已连接到 {host || '本机'}
      </div>
      {notice ? (
        <div className="m-notice">
          <p title={`${MOBILE_SECURITY_COPY} ${MOBILE_KEEP_AWAKE_COPY}`}>
            仅扫自己的码 · 远程时请保持 Mac 唤醒
          </p>
          <button
            type="button"
            className="m-icon"
            aria-label="关闭提示"
            onClick={() => {
              setNotice(false)
              try {
                localStorage.setItem(NOTICE_KEY, '1')
              } catch {
                /* Dismissed for this visit. */
              }
            }}
          >
            ×
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="m-notice is-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="m-list-meta">
        <strong>当前设备上的项目和会话</strong>
        <small>
          {visible.length} 个项目 · {total} 个会话
        </small>
      </div>
      <div className={`m-search${searching ? ' is-on' : ''}`}>
        <input
          type="search"
          placeholder="搜索会话"
          aria-label="搜索会话"
          enterKeyHint="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="m-list-scroll">
        {visible.length === 0 ? (
          <p className="m-empty">{query ? '没有匹配的会话' : '还没有会话'}</p>
        ) : null}
        {visible.map((group) => {
          const expanded = Boolean(query) || isOpen(group.path)
          const latest = group.sessions.map((session) => session.timeLabel).find(Boolean)
          return (
            <article className={`m-project${expanded ? ' is-open' : ''}`} key={group.path}>
              <button
                type="button"
                className="m-project-head"
                aria-expanded={expanded}
                onClick={() => toggle(group.path)}
              >
                <span className="m-folder">
                  <Folder size={15} />
                </span>
                <span className="m-project-meta">
                  <span className="m-project-name">{group.name}</span>
                  <span className="m-project-sub">
                    {group.path}
                    {latest ? ` · 更新于 ${latest}` : ''}
                  </span>
                </span>
                <span className="m-count">{group.sessions.length}</span>
                <ChevronRight className="m-chevron" size={16} aria-hidden="true" />
              </button>
              {expanded ? (
                <div className="m-project-sessions">
                  <button
                    type="button"
                    className="m-session m-new-session"
                    onClick={() => onNewSession(group.path)}
                  >
                    <Plus size={15} aria-hidden="true" />
                    <span className="m-session-title">新会话</span>
                  </button>
                  {group.sessions.map((session) => {
                    const badge = mobileStatusBadge(session.status)
                    return (
                      <button
                        type="button"
                        key={session.key}
                        className={`m-session${session.workerId && session.workerId === selected ? ' is-on' : ''}`}
                        data-worker={session.workerId ?? ''}
                        onClick={() => onOpen(session)}
                      >
                        <span className="m-session-title">{session.title}</span>
                        <span className="m-when">{session.timeLabel}</span>
                        <span className={`m-pill is-${badge.kind}`}>{badge.label}</span>
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </article>
          )
        })}
      </div>
    </>
  )
}
