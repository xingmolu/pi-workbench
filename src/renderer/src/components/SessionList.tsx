import { useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import { sessionStatusDisplay } from '../../../shared/session-presentation'
import { t } from '../../../shared/i18n'

function relativeTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime())
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return t('刚刚')
  if (minutes < 60) return t('{minutes} 分钟前', { minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('{hours} 小时前', { hours })
  const days = Math.floor(hours / 24)
  return days < 30 ? t('{days} 天前', { days }) : new Date(value).toLocaleDateString('zh-CN')
}

export default function SessionList({
  snapshot,
  onOpenSession
}: {
  snapshot: AgentSnapshot
  onOpenSession: (path: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const sessions = snapshot.sessions.filter((session) =>
    session.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  )
  return (
    <section className="sidebar-section session-section">
      <div className="sidebar-label">{t('会话')}</div>
      {snapshot.project ? (
        <div className="session-search">
          <Search size={13} aria-hidden="true" />
          <input
            ref={searchInput}
            aria-label={t('搜索会话标题')}
            placeholder={t('搜索会话标题')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              aria-label={t('清除搜索')}
              title={t('清除搜索')}
              onClick={() => {
                setQuery('')
                searchInput.current?.focus()
              }}
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="session-list">
        {sessions.map((session) => {
          const status = sessionStatusDisplay(session.status)
          return (
            <button
              key={session.path}
              className={`session-row${session.active ? ' is-active' : ''}`}
              type="button"
              onClick={() => onOpenSession(session.path)}
              title={session.title}
            >
              <span className="session-title">{session.title}</span>
              <span className="session-meta">
                {session.parentSessionPath || session.parentUnavailable ? (
                  <span className="session-fork-label">{t('分叉')}</span>
                ) : null}
                <i className={`session-status-dot is-${status.tone}`} aria-hidden="true" />
                <span className={`session-status-label is-${status.tone}`}>{status.label}</span>
                <span>{relativeTime(session.modified)}</span>
              </span>
            </button>
          )
        })}
        {!snapshot.project ? (
          <p className="sidebar-empty">{t('选择工作区后查看会话。')}</p>
        ) : snapshot.sessions.length === 0 ? (
          <p className="sidebar-empty">{t('还没有会话。从上面的按钮开始。')}</p>
        ) : sessions.length === 0 ? (
          <p className="sidebar-empty" role="status">
            {t('没有匹配的会话标题')}
          </p>
        ) : null}
      </div>
    </section>
  )
}
