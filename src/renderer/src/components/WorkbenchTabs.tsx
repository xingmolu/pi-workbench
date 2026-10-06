import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useLayoutEffect, useRef } from 'react'
import {
  Blocks,
  Files,
  FlaskConical,
  GitBranch,
  GitPullRequest,
  Globe2,
  Plus,
  Puzzle,
  TerminalSquare,
  X,
  type LucideIcon
} from 'lucide-react'
import type { WorkbenchContribution, WorkbenchIcon } from '../../../shared/contracts'
import { shortcutLabel } from './shortcut-label'
import { t } from '../../../shared/i18n'
import '../assets/workbench-tabs.css'
const icons: Record<WorkbenchIcon, LucideIcon> = {
  files: Files,
  'git-review': GitPullRequest,
  'git-branch': GitBranch,
  terminal: TerminalSquare,
  browser: Globe2,
  plugin: Puzzle,
  flask: FlaskConical
}
/** The icon a contribution declares, from the host's icon set. */
export function ContributionIcon({
  contribution,
  size = 16
}: {
  contribution: WorkbenchContribution
  size?: number
}): React.JSX.Element {
  const Component = icons[contribution.icon] ?? Blocks
  return <Component size={size} aria-hidden="true" />
}
function Icon({ contribution }: { contribution: WorkbenchContribution }): React.JSX.Element {
  const Component = icons[contribution.icon] ?? Blocks
  return <Component size={16} aria-hidden="true" />
}
type Props = {
  contributions: WorkbenchContribution[]
  openedViewIds: readonly string[]
  selectedViewId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
}
const DESCRIPTIONS: Partial<Record<WorkbenchIcon, string>> = {
  files: t('浏览和预览项目文件'),
  'git-review': t('审查未提交的改动'),
  'git-branch': t('分支、提交与历史'),
  terminal: t('在项目目录里运行命令'),
  browser: t('预览网页和本地服务')
}
export function WorkbenchLauncher({
  contributions,
  onSelect
}: Pick<Props, 'contributions' | 'onSelect'>): React.JSX.Element {
  return (
    <nav className="workbench-launcher" aria-label={t('打开工作台工具')}>
      {contributions.length ? (
        <>
          <div className="workbench-launcher-head" aria-hidden="true">
            <strong>{t('工作台')}</strong>
            <span>{t('在对话旁边打开工具，改动、文件和命令都在这里。')}</span>
          </div>
          <div className="workbench-launcher-grid">
            {contributions.map((contribution) => (
              <button
                key={contribution.viewId}
                title={contribution.title}
                aria-label={contribution.title}
                onClick={() => onSelect(contribution.viewId)}
              >
                <span className="workbench-launcher-icon">
                  <Icon contribution={contribution} />
                </span>
                <span className="workbench-launcher-text">
                  <strong>{contribution.title}</strong>
                  <small>
                    {DESCRIPTIONS[contribution.icon] ??
                      (contribution.pluginId.startsWith('works.pi.')
                        ? t('内置工具')
                        : t('插件提供'))}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p>{t('暂无可用面板')}</p>
      )}
    </nav>
  )
}
export default function WorkbenchTabs({
  contributions,
  openedViewIds,
  selectedViewId,
  onSelect,
  onClose,
  menuOpen,
  onMenuOpenChange
}: Props): React.JSX.Element {
  const root = useRef<HTMLElement>(null)
  const restoreFocus = useRef(false)
  const focusedTab = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (
      focusedTab.current &&
      !openedViewIds.includes(focusedTab.current) &&
      document.activeElement === document.body
    )
      restoreFocus.current = true
    if (!restoreFocus.current) return
    restoreFocus.current = false
    const target =
      root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
      root.current?.parentElement?.querySelector<HTMLElement>('.workbench-launcher button')
    target?.focus()
  }, [openedViewIds])
  const close = (id: string): void => {
    restoreFocus.current = true
    onClose(id)
  }
  if (!openedViewIds.length) return <header className="workbench-tabs-head" ref={root} />
  return (
    <header
      className="workbench-tabs-head"
      ref={root}
      onFocusCapture={(event) => {
        focusedTab.current =
          (event.target as HTMLElement).closest<HTMLElement>('[data-view-id]')?.dataset.viewId ??
          null
      }}
    >
      <div className="workbench-tabs" role="tablist" aria-label={t('已打开的工作台工具')}>
        {openedViewIds.map((id, index) => {
          const contribution = contributions.find((item) => item.viewId === id)
          return contribution ? (
            <div
              className="workbench-tab"
              key={id}
              data-view-id={id}
              data-active={selectedViewId === id}
            >
              <button
                role="tab"
                title={contribution.title}
                id={`workbench-tab-${id}`}
                aria-controls="workbench-active-panel"
                tabIndex={selectedViewId === id ? 0 : -1}
                aria-selected={selectedViewId === id}
                onClick={() => onSelect(id)}
                onKeyDown={(event) => {
                  const index = openedViewIds.indexOf(id)
                  const next =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? openedViewIds.length - 1
                        : event.key === 'ArrowRight'
                          ? (index + 1) % openedViewIds.length
                          : event.key === 'ArrowLeft'
                            ? (index + openedViewIds.length - 1) % openedViewIds.length
                            : -1
                  if (event.key === 'Delete') {
                    event.preventDefault()
                    close(id)
                    return
                  }
                  if (next < 0) return
                  event.preventDefault()
                  onSelect(openedViewIds[next])
                  document.getElementById(`workbench-tab-${openedViewIds[next]}`)?.focus()
                }}
              >
                <Icon contribution={contribution} />
                <span className="workbench-tab-title">{contribution.title}</span>
                {index < 9 ? (
                  <kbd className="workbench-tab-shortcut" aria-hidden="true">
                    {shortcutLabel(String(index + 1))}
                  </kbd>
                ) : null}
              </button>
              <button
                className="workbench-tab-close"
                aria-label={t('关闭{title}标签', { title: contribution.title })}
                onClick={() => close(id)}
              >
                <X size={12} />
              </button>
            </div>
          ) : null
        })}
      </div>
      <DropdownMenu.Root open={menuOpen} onOpenChange={onMenuOpenChange}>
        <DropdownMenu.Trigger className="icon-btn workbench-add" aria-label={t('打开工具')}>
          <Plus size={16} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="workbench-add-menu"
            sideOffset={6}
            align="end"
            onCloseAutoFocus={(event) => {
              // Radix restores focus on a later timer. Respect a newer focus
              // choice made after the menu disappeared (e.g. tab arrow keys).
              const active = document.activeElement
              if (active && active !== document.body && active.isConnected) event.preventDefault()
            }}
          >
            {contributions.map((contribution) => (
              <DropdownMenu.Item
                key={contribution.viewId}
                title={contribution.title}
                onSelect={() => onSelect(contribution.viewId)}
              >
                <Icon contribution={contribution} />
                <span>{contribution.title}</span>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </header>
  )
}
