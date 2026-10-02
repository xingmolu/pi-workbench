import { useEffect, useRef, useState, type ReactNode } from 'react'
import LibraryManager from './navigation/LibraryManager'
import { useNavigationLibrary } from '../store/navigation-library'
import { performNavigationAction } from '../store/navigation-feedback'
import {
  ChevronsLeft,
  ArchiveRestore,
  FolderOpen,
  MessageSquarePlus,
  PanelLeft,
  Search,
  Settings2
} from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import { canCreateSession } from '../../../shared/session-presentation'
import ProjectSessionList from './ProjectSessionList'
import { projectNavigationReason } from '../../../shared/project-catalog'
import type { ProjectCatalog, ProjectNavigationFailures } from '../../../shared/project-catalog'
import { shortcutLabel } from './shortcut-label'
import { t } from '../../../shared/i18n'

type SidebarProps = {
  runtimePicker?: ReactNode
  collapsed: boolean
  collapseLocked?: boolean
  snapshot: AgentSnapshot
  onToggle: () => void
  onChooseProject: () => void
  onNewSession: () => void
  onNavigate: (cwd: string, sessionPath?: string, workerId?: string, runtimeId?: string) => void
  onCatalog?: (catalog: ProjectCatalog | null) => void
  navigationFailures?: ProjectNavigationFailures
  pending?: boolean
  disabledReason?: string | null
  onOpenSettings: () => void
  onOpenSearch: () => void
}

export default function Sidebar({
  runtimePicker,
  collapsed,
  collapseLocked = false,
  snapshot,
  onToggle,
  onChooseProject,
  onNewSession,
  onNavigate,
  onCatalog,
  navigationFailures,
  pending = false,
  disabledReason,
  onOpenSettings,
  onOpenSearch
}: SidebarProps): React.JSX.Element {
  const [managerOpen, setManagerOpen] = useState(false)
  const savedWidth = useNavigationLibrary((state) => state.library.layout.sidebarWidth ?? 248)
  const [width, setWidth] = useState(savedWidth)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const currentWidth = useRef(width)
  useEffect(() => {
    setWidth(savedWidth)
    currentWidth.current = savedWidth
  }, [savedWidth])
  useEffect(() => {
    const finish = (): void => {
      if (!drag.current) return
      drag.current = null
      document.body.classList.remove('is-sidebar-resizing')
      void performNavigationAction({
        type: 'layout:save',
        layout: { sidebarWidth: currentWidth.current }
      })
    }
    const move = (event: PointerEvent): void => {
      if (!drag.current) return
      const next = Math.round(
        Math.min(360, Math.max(208, drag.current.width + event.clientX - drag.current.x))
      )
      currentWidth.current = next
      setWidth(next)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      document.body.classList.remove('is-sidebar-resizing')
    }
  }, [])
  const blockReason = disabledReason ?? projectNavigationReason(snapshot)
  const reason = blockReason ?? (pending ? t('正在切换会话，请稍候') : null)
  const pendingOnly = (pending && !blockReason) || undefined
  const newSessionEnabled = snapshot.ready && canCreateSession(snapshot.project) && !reason
  if (collapsed) {
    return (
      <aside className="sidebar is-collapsed" aria-label={t('折叠的侧栏')}>
        <div className="rail-top">
          <button
            className="icon-btn"
            type="button"
            onClick={onOpenSearch}
            aria-label={t('搜索所有会话')}
            title={t('搜索所有会话（⌘K）')}
          >
            <Search size={17} />
          </button>
          <button
            className="icon-btn"
            type="button"
            onClick={onToggle}
            title={collapseLocked ? t('设置打开时侧栏保持折叠') : t('展开侧栏')}
            disabled={collapseLocked}
          >
            <PanelLeft size={17} />
          </button>
          <button
            className="icon-btn"
            type="button"
            onClick={onNewSession}
            title={reason ?? t('新会话')}
            aria-label={t('新会话')}
            data-navigation-pending={snapshot.project ? pendingOnly : undefined}
            disabled={!newSessionEnabled}
          >
            <MessageSquarePlus size={17} />
          </button>
          <button
            className="icon-btn"
            type="button"
            onClick={onChooseProject}
            title={reason ?? t('添加项目')}
            aria-label={t('添加项目')}
            data-navigation-pending={pendingOnly}
            disabled={Boolean(reason)}
          >
            <FolderOpen size={17} />
          </button>
        </div>
        <div className="rail-spacer" />
        <button
          className="icon-btn"
          type="button"
          aria-label={t('管理项目与归档')}
          title={t('管理项目与归档')}
          onClick={() => setManagerOpen(true)}
        >
          <ArchiveRestore size={17} />
        </button>
        {managerOpen && <LibraryManager onClose={() => setManagerOpen(false)} />}
        <span className={`host-dot${snapshot.ready ? ' is-on' : ''}`} title="Agent Host" />
        <button className="icon-btn" type="button" onClick={onOpenSettings} title={t('设置')}>
          <Settings2 size={17} />
        </button>
      </aside>
    )
  }

  return (
    <aside className="sidebar" aria-label={t('项目和会话')} style={{ width, flexBasis: width }}>
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark">π</span>
          <span className="brand-name">Pi Desktop</span>
        </div>
        <button
          className="icon-btn"
          type="button"
          onClick={onToggle}
          title={t('收起侧栏（⌘B）')}
          data-shortcut="⌘B"
        >
          <ChevronsLeft size={16} />
        </button>
      </div>

      <div className="sidebar-project-actions">
        <div className={`sidebar-new-session-group${runtimePicker ? ' has-engine' : ''}`}>
          <button
            type="button"
            className="sidebar-new-session"
            data-shortcut={shortcutLabel('N')}
            onClick={onNewSession}
            disabled={!newSessionEnabled}
            data-navigation-pending={snapshot.project ? pendingOnly : undefined}
            title={
              reason ??
              t('在当前项目中新建会话（{value}）', { value: snapshot.runtime?.label ?? 'Pi' })
            }
          >
            <MessageSquarePlus size={15} />

            {t('新会话')}
          </button>
          {runtimePicker}
        </div>
        <button
          type="button"
          className="sidebar-add-project"
          onClick={onChooseProject}
          disabled={Boolean(reason)}
          data-navigation-pending={pendingOnly}
          aria-label={t('添加项目')}
          title={reason ?? t('添加项目')}
        >
          <FolderOpen size={15} />
        </button>
      </div>
      <button
        className="sidebar-global-search"
        type="button"
        onClick={onOpenSearch}
        aria-label={t('搜索所有会话')}
      >
        <Search size={14} />

        {t('搜索所有会话')}
        <kbd>⌘K</kbd>
      </button>
      <ProjectSessionList
        snapshot={snapshot}
        onNavigate={onNavigate}
        onCatalog={onCatalog}
        navigationFailures={navigationFailures}
        pending={pending}
        disabledReason={disabledReason}
      />

      <div className="sidebar-foot">
        <button type="button" onClick={() => setManagerOpen(true)}>
          <ArchiveRestore size={15} />
          {t('管理项目与归档')}
        </button>
        <div className="sidebar-foot-row">
          <button type="button" onClick={onOpenSettings}>
            <Settings2 size={15} />

            {t('设置')}
          </button>
          <span className="sidebar-host" title={snapshot.agentDir}>
            <span className={`host-dot${snapshot.ready ? ' is-on' : ''}`} />
            <span>
              {snapshot.runtime?.label ?? 'Pi'} {snapshot.ready ? t('引擎已就绪') : t('引擎未连接')}
            </span>
          </span>
        </div>
      </div>
      {managerOpen && <LibraryManager onClose={() => setManagerOpen(false)} />}
      <div
        className="sidebar-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label={t('调整侧栏宽度')}
        aria-orientation="vertical"
        aria-valuemin={208}
        aria-valuemax={360}
        aria-valuenow={width}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          drag.current = { x: event.clientX, width }
          document.body.classList.add('is-sidebar-resizing')
        }}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next =
            event.key === 'Home'
              ? 208
              : event.key === 'End'
                ? 360
                : Math.min(360, Math.max(208, width + (event.key === 'ArrowLeft' ? -8 : 8)))
          setWidth(next)
          currentWidth.current = next
          void performNavigationAction({ type: 'layout:save', layout: { sidebarWidth: next } })
        }}
      />
    </aside>
  )
}
