import {
  ChevronsLeft,
  ChevronsRight,
  FolderOpen,
  MessageSquarePlus,
  PanelLeft,
  Settings2
} from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import { canCreateSession, sessionStatusDisplay } from '../../../shared/session-presentation'

type SidebarProps = {
  collapsed: boolean
  collapseLocked?: boolean
  snapshot: AgentSnapshot
  onToggle: () => void
  onChooseProject: () => void
  onNewSession: () => void
  onOpenSession: (path: string) => void
  onOpenSettings: () => void
}

function relativeTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime())
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return days < 30 ? `${days} 天前` : new Date(value).toLocaleDateString('zh-CN')
}

export default function Sidebar({
  collapsed,
  collapseLocked = false,
  snapshot,
  onToggle,
  onChooseProject,
  onNewSession,
  onOpenSession,
  onOpenSettings
}: SidebarProps): React.JSX.Element {
  const newSessionEnabled = canCreateSession(snapshot.project)
  if (collapsed) {
    return (
      <aside className="sidebar is-collapsed" aria-label="折叠的侧栏">
        <div className="rail-top">
          <button
            className="icon-btn"
            type="button"
            onClick={onToggle}
            title={collapseLocked ? '设置打开时侧栏保持折叠' : '展开侧栏'}
            disabled={collapseLocked}
          >
            <PanelLeft size={17} />
          </button>
          <button
            className="icon-btn"
            type="button"
            onClick={onNewSession}
            title="新会话"
            disabled={!newSessionEnabled}
          >
            <MessageSquarePlus size={17} />
          </button>
          {snapshot.project ? (
            <button className="icon-btn" type="button" onClick={onChooseProject} title="切换工作区">
              <FolderOpen size={17} />
            </button>
          ) : (
            <span className="rail-static" title="尚未选择工作区" aria-label="尚未选择工作区">
              <FolderOpen size={17} />
            </span>
          )}
        </div>
        <div className="rail-spacer" />
        <span className={`host-dot${snapshot.ready ? ' is-on' : ''}`} title="Agent Host" />
        <button className="icon-btn" type="button" onClick={onOpenSettings} title="设置">
          <Settings2 size={17} />
        </button>
      </aside>
    )
  }

  return (
    <aside className="sidebar" aria-label="项目和会话">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark">π</span>
          <span className="brand-name">Pi Desktop</span>
        </div>
        <button className="icon-btn" type="button" onClick={onToggle} title="收起侧栏（⌘B）">
          <ChevronsLeft size={16} />
        </button>
      </div>

      <button
        className="new-session"
        type="button"
        onClick={onNewSession}
        disabled={!newSessionEnabled}
      >
        <MessageSquarePlus size={15} />
        新会话
      </button>

      <section className="sidebar-section project-section">
        <div className="sidebar-label">工作区</div>
        {snapshot.project ? (
          <button
            className="project-row"
            type="button"
            onClick={onChooseProject}
            title={snapshot.project.path}
          >
            <FolderOpen size={15} />
            <span>
              <strong>{snapshot.project.name}</strong>
              <small>{snapshot.project.path}</small>
            </span>
            <ChevronsRight size={14} />
          </button>
        ) : (
          <div className="project-empty-state" aria-label="尚未选择工作区">
            <FolderOpen size={16} />
            尚未选择
          </div>
        )}
      </section>

      <section className="sidebar-section session-section">
        <div className="sidebar-label">会话</div>
        <div className="session-list">
          {snapshot.sessions.map((session) => {
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
                  <i className={`session-status-dot is-${status.tone}`} aria-hidden="true" />
                  <span className={`session-status-label is-${status.tone}`}>{status.label}</span>
                  <span>{relativeTime(session.modified)}</span>
                </span>
              </button>
            )
          })}
          {snapshot.project && snapshot.sessions.length === 0 ? (
            <p className="sidebar-empty">还没有会话。从上面的按钮开始。</p>
          ) : null}
        </div>
      </section>

      <div className="sidebar-spacer" />
      <div className="sidebar-host" title={snapshot.agentDir}>
        <span className={`host-dot${snapshot.ready ? ' is-on' : ''}`} />
        <span>{snapshot.ready ? 'Pi 引擎已就绪' : '正在连接 Pi 引擎'}</span>
      </div>
      <div className="sidebar-foot">
        <button type="button" onClick={onOpenSettings}>
          <Settings2 size={15} />
          设置
        </button>
      </div>
    </aside>
  )
}
