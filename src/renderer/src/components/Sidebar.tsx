import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigationLibrary } from '../store/navigation-library'
import { performNavigationAction } from '../store/navigation-feedback'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronDown, FolderPlus, Search, Settings2, SquarePen } from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import { canCreateSession } from '../../../shared/session-presentation'
import ProjectSessionList from './ProjectSessionList'
import { projectNavigationReason } from '../../../shared/project-catalog'
import type { ProjectCatalog, ProjectNavigationFailures } from '../../../shared/project-catalog'
import { shortcutLabel } from './shortcut-label'
import { t } from '../../../shared/i18n'

type SidebarProps = {
  /** Back, forward and the sidebar switch, in the title bar row. */
  windowControls?: ReactNode
  onOpenSearch?: () => void
  onOpenSettings?: () => void
  runtimePicker?: ReactNode
  collapsed: boolean
  snapshot: AgentSnapshot
  onChooseProject: () => void
  onNewSession: () => void
  onNavigate: (cwd: string, sessionPath?: string, workerId?: string, runtimeId?: string) => void
  onCatalog?: (catalog: ProjectCatalog | null) => void
  navigationFailures?: ProjectNavigationFailures
  pending?: boolean
  disabledReason?: string | null
}

export default function Sidebar({
  windowControls,
  onOpenSearch,
  onOpenSettings,
  runtimePicker,
  collapsed,
  snapshot,
  onChooseProject,
  onNewSession,
  onNavigate,
  onCatalog,
  navigationFailures,
  pending = false,
  disabledReason
}: SidebarProps): React.JSX.Element | null {
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
  // Folded, the activity rail alone stays; it keeps search, subagents and settings.
  if (collapsed) return null

  return (
    <aside className="sidebar" aria-label={t('项目和会话')} style={{ width, flexBasis: width }}>
      <div className="sidebar-head">{windowControls}</div>

      <div className="sidebar-brand-row">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className="brand" aria-label={t('Pi Desktop 菜单')}>
            <span className="brand-mark">π</span>
            <span className="brand-name">Pi Desktop</span>
            <ChevronDown className="brand-chevron" size={14} aria-hidden="true" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="brand-menu" sideOffset={6} align="start">
              <DropdownMenu.Item disabled={!newSessionEnabled} onSelect={onNewSession}>
                <SquarePen size={15} />
                <span>{t('新会话')}</span>
                <kbd>{shortcutLabel('N')}</kbd>
              </DropdownMenu.Item>
              <DropdownMenu.Item disabled={Boolean(reason)} onSelect={onChooseProject}>
                <FolderPlus size={15} />
                <span>{t('添加项目')}</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => onOpenSearch?.()}>
                <Search size={15} />
                <span>{t('搜索所有会话')}</span>
                <kbd>{shortcutLabel('K')}</kbd>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="brand-menu-separator" />
              <DropdownMenu.Item onSelect={() => onOpenSettings?.()}>
                <Settings2 size={15} />
                <span>{t('设置')}</span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button
          type="button"
          className="sidebar-add-project"
          onClick={onChooseProject}
          disabled={Boolean(reason)}
          data-navigation-pending={pendingOnly}
          aria-label={t('添加项目')}
          title={reason ?? t('添加项目')}
        >
          <FolderPlus size={16} />
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
            <SquarePen size={15} />
            {t('新会话')}
          </button>
          {runtimePicker}
        </div>
      </div>
      <ProjectSessionList
        snapshot={snapshot}
        onNavigate={onNavigate}
        onCatalog={onCatalog}
        navigationFailures={navigationFailures}
        pending={pending}
        disabledReason={disabledReason}
      />

      <div className="sidebar-foot">
        <div className="sidebar-foot-row">
          <span className="sidebar-host" title={snapshot.agentDir}>
            <span className={`host-dot${snapshot.ready ? ' is-on' : ''}`} />
            <span>
              {snapshot.runtime?.label ?? 'Pi'} {snapshot.ready ? t('引擎已就绪') : t('引擎未连接')}
            </span>
          </span>
        </div>
      </div>
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
