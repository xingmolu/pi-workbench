import { ChevronsLeft, FolderOpen, MessageSquarePlus, PanelLeft, Search, Settings2 } from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import { canCreateSession } from '../../../shared/session-presentation'
import ProjectSessionList from './ProjectSessionList'
import { projectNavigationReason } from '../../../shared/project-catalog'
import type { ProjectNavigationFailures } from '../../../shared/project-catalog'

type SidebarProps = {
  collapsed: boolean
  collapseLocked?: boolean
  snapshot: AgentSnapshot
  onToggle: () => void
  onChooseProject: () => void
  onNewSession: () => void
  onNavigate: (cwd: string, sessionPath?: string, workerId?: string) => void
  navigationFailures?: ProjectNavigationFailures
  pending?: boolean
  disabledReason?: string | null
  onOpenSettings: () => void
  onOpenSearch: () => void
}

export default function Sidebar({
  collapsed,
  collapseLocked = false,
  snapshot,
  onToggle,
  onChooseProject,
  onNewSession,
  onNavigate,
  navigationFailures,
  pending = false,
  disabledReason,
  onOpenSettings,
  onOpenSearch
}: SidebarProps): React.JSX.Element {
  const blockReason = disabledReason ?? projectNavigationReason(snapshot)
  const reason = blockReason ?? (pending ? '正在切换会话，请稍候' : null)
  const pendingOnly = (pending && !blockReason) || undefined
  const newSessionEnabled = snapshot.ready && canCreateSession(snapshot.project) && !reason
  if (collapsed) {
    return (
      <aside className="sidebar is-collapsed" aria-label="折叠的侧栏">
        <div className="rail-top">
          <button className="icon-btn" type="button" onClick={onOpenSearch} aria-label="搜索所有会话" title="搜索所有会话（⌘K）"><Search size={17} /></button>
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
            title={reason ?? '新会话'}
            aria-label="新会话"
            data-navigation-pending={snapshot.project ? pendingOnly : undefined}
            disabled={!newSessionEnabled}
          >
            <MessageSquarePlus size={17} />
          </button>
          {snapshot.project ? (
            <button
              className="icon-btn"
              type="button"
              onClick={onChooseProject}
              title={reason ?? '添加项目'}
              aria-label="添加项目"
              data-navigation-pending={pendingOnly}
              disabled={Boolean(reason)}
            >
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

      <div className="sidebar-project-actions">
        <button
          type="button"
          onClick={onChooseProject}
          disabled={Boolean(reason)}
          data-navigation-pending={pendingOnly}
          title={reason ?? '添加项目'}
        >
          <FolderOpen size={14} />
          添加项目
        </button>
        <button
          type="button"
          onClick={onNewSession}
          disabled={!newSessionEnabled}
          data-navigation-pending={snapshot.project ? pendingOnly : undefined}
          title={reason ?? '在当前项目中新建会话'}
        >
          <MessageSquarePlus size={14} />
          新会话
        </button>
      </div>
      <button className="sidebar-global-search" type="button" onClick={onOpenSearch} aria-label="搜索所有会话"><Search size={14} />搜索所有会话<kbd>⌘K</kbd></button>
      <ProjectSessionList
        snapshot={snapshot}
        onNavigate={onNavigate}
        navigationFailures={navigationFailures}
        pending={pending}
        disabledReason={disabledReason}
      />

      <div className="sidebar-host" title={snapshot.agentDir}>
        <span className={`host-dot${snapshot.ready ? ' is-on' : ''}`} />
        <span>{snapshot.ready ? 'Pi 引擎已就绪' : 'Pi 引擎未连接'}</span>
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
