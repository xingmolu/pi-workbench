import { Bot, MessagesSquare, Search, Settings2 } from 'lucide-react'
import { shortcutLabel } from './shortcut-label'
import { t } from '../../../shared/i18n'
import '../assets/activity-rail.css'

type ActivityRailProps = {
  sidebarOpen: boolean
  sidebarLocked: boolean
  onToggleSidebar: () => void
  onOpenSearch: () => void
  /** Absent while there is no project, so the subagent list has nothing to show. */
  subagents?: { open: boolean; onToggle: () => void }
  onOpenSettings: () => void
}

/**
 * The window's leftmost column: switches what the navigation column shows and holds the
 * app-wide entries (search, subagents, settings). It stays put when the sidebar folds.
 */
export default function ActivityRail({
  sidebarOpen,
  sidebarLocked,
  onToggleSidebar,
  onOpenSearch,
  subagents,
  onOpenSettings
}: ActivityRailProps): React.JSX.Element {
  return (
    <nav className="activity-rail" aria-label={t('活动栏')}>
      <div className="activity-rail-group">
        <button
          type="button"
          className={`activity-rail-button${sidebarOpen ? ' is-active' : ''}`}
          aria-label={t('项目和会话')}
          aria-pressed={sidebarOpen}
          title={
            sidebarLocked
              ? t('设置打开时侧栏保持折叠')
              : sidebarOpen
                ? t('收起项目和会话（⌘B）')
                : t('展开项目和会话（⌘B）')
          }
          disabled={sidebarLocked}
          onClick={onToggleSidebar}
        >
          <MessagesSquare size={18} />
        </button>
        <button
          type="button"
          className="activity-rail-button"
          aria-label={t('搜索所有会话')}
          title={t('搜索所有会话（{shortcut}）', { shortcut: shortcutLabel('K') })}
          onClick={onOpenSearch}
        >
          <Search size={18} />
        </button>
        {subagents ? (
          <button
            type="button"
            className={`activity-rail-button${subagents.open ? ' is-active' : ''}`}
            data-rail="subagents"
            aria-label={t('子 Agent 列表')}
            aria-pressed={subagents.open}
            title={t('子 Agent 列表')}
            onClick={subagents.onToggle}
          >
            <Bot size={18} />
          </button>
        ) : null}
      </div>
      <div className="activity-rail-group">
        <button
          type="button"
          className="activity-rail-button"
          aria-label={t('设置')}
          title={t('设置')}
          onClick={onOpenSettings}
        >
          <Settings2 size={18} />
        </button>
      </div>
    </nav>
  )
}
