import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useEffect, useLayoutEffect, useRef } from 'react'
import {
  Blocks,
  Files,
  FlaskConical,
  GitBranch,
  GitPullRequest,
  Globe2,
  LoaderCircle,
  Plus,
  Puzzle,
  TerminalSquare,
  X,
  type LucideIcon
} from 'lucide-react'
import type { WorkbenchContribution, WorkbenchIcon } from '../../../shared/contracts'
import { shortcutLabel } from './shortcut-label'
import {
  browserOperate,
  followBrowserState,
  forgetSite,
  useBrowserState,
  useRecentSites
} from '../store/browser-state'
import {
  isActiveTab,
  isBrowserContribution,
  workbenchTabId,
  workbenchTabItems,
  type WorkbenchTabItem
} from '../store/workbench-tab-items'
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
/** Keyboard shortcuts the app binds to opening a tool. */
function toolShortcut(contribution: WorkbenchContribution): string | null {
  if (contribution.surface.kind !== 'first-party') return null
  if (contribution.surface.adapter === 'terminal') return shortcutLabel('J')
  if (contribution.surface.adapter === 'files') return shortcutLabel('P')
  return null
}

function siteHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The workbench's start page: its tools, then the sites visited recently in its browser. */
export function WorkbenchLauncher({
  contributions,
  onSelect,
  onOpenSite
}: Pick<Props, 'contributions' | 'onSelect'> & {
  onOpenSite?: (url: string) => void
}): React.JSX.Element {
  const sites = useRecentSites((store) => store.sites)
  const browserAvailable = contributions.some(isBrowserContribution)
  return (
    <nav className="workbench-launcher" aria-label={t('打开工作台工具')}>
      {contributions.length ? (
        <>
          <section className="workbench-launcher-section" aria-labelledby="launcher-tools">
            <h2 id="launcher-tools">{t('工具')}</h2>
            <div className="workbench-launcher-grid">
              {contributions.map((contribution) => {
                const shortcut = toolShortcut(contribution)
                return (
                  <button
                    key={contribution.viewId}
                    className="workbench-launcher-tool"
                    title={contribution.title}
                    aria-label={contribution.title}
                    onClick={() => onSelect(contribution.viewId)}
                  >
                    <Icon contribution={contribution} />
                    <span className="workbench-launcher-title">{contribution.title}</span>
                    {shortcut ? <kbd aria-hidden="true">{shortcut}</kbd> : null}
                  </button>
                )
              })}
            </div>
          </section>
          {browserAvailable && onOpenSite && sites.length ? (
            <section className="workbench-launcher-section" aria-labelledby="launcher-sites">
              <h2 id="launcher-sites">{t('推荐')}</h2>
              <div className="workbench-launcher-sites">
                {sites.map((site) => {
                  const host = siteHost(site.url)
                  return (
                    <div className="workbench-launcher-site" key={site.url}>
                      <button
                        className="workbench-launcher-site-open"
                        title={site.url}
                        onClick={() => onOpenSite(site.url)}
                      >
                        <span
                          className="workbench-launcher-site-mark"
                          style={{ '--site-hue': hueOf(host) } as React.CSSProperties}
                          aria-hidden="true"
                        >
                          {(site.title.trim() || host).charAt(0).toUpperCase()}
                        </span>
                        <span className="workbench-launcher-site-title">{site.title}</span>
                        <small>{host}</small>
                      </button>
                      <button
                        className="workbench-launcher-site-forget"
                        aria-label={t('从推荐中移除 {title}', { title: site.title })}
                        title={t('从推荐中移除')}
                        onClick={() => forgetSite(site.url)}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </section>
          ) : null}
        </>
      ) : (
        <p>{t('暂无可用面板')}</p>
      )}
    </nav>
  )
}

function hueOf(text: string): number {
  let hash = 0
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 360
  return hash
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
  useEffect(followBrowserState, [])
  const browser = useBrowserState((store) => store.state)
  const items = workbenchTabItems(contributions, openedViewIds, browser, t('新标签页'))
  const itemKeys = items.map(({ key }) => key).join('\n')
  useLayoutEffect(() => {
    if (
      focusedTab.current &&
      !itemKeys.split('\n').includes(focusedTab.current) &&
      document.activeElement === document.body
    )
      restoreFocus.current = true
    if (!restoreFocus.current) return
    restoreFocus.current = false
    const target =
      root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
      root.current?.parentElement?.querySelector<HTMLElement>('.workbench-launcher button')
    target?.focus()
  }, [itemKeys])
  const select = (item: WorkbenchTabItem): void => {
    onSelect(item.viewId)
    if (item.pageId && item.pageId !== browser.activePageId)
      void browserOperate({ action: 'select_tab', pageId: item.pageId })
  }
  const close = (item: WorkbenchTabItem): void => {
    restoreFocus.current = true
    // A browser page closes on its own; the last one closes the browser too, leaving only
    // the blank page the browser keeps for next time.
    if (item.pageId) void browserOperate({ action: 'close_tab', pageId: item.pageId })
    if (!item.pageId || browser.pages.length <= 1) onClose(item.viewId)
  }
  const open = (contribution: WorkbenchContribution): void => {
    onSelect(contribution.viewId)
    // With the browser already open, asking for it again means another page.
    if (
      isBrowserContribution(contribution) &&
      openedViewIds.includes(contribution.viewId) &&
      browser.pages.length
    )
      void browserOperate({ action: 'new_tab' })
  }
  if (!items.length) return <header className="workbench-tabs-head" ref={root} />
  return (
    <header
      className="workbench-tabs-head"
      ref={root}
      onFocusCapture={(event) => {
        focusedTab.current =
          (event.target as HTMLElement).closest<HTMLElement>('[data-tab-key]')?.dataset.tabKey ??
          null
      }}
    >
      <div className="workbench-tabs" role="tablist" aria-label={t('已打开的工作台工具')}>
        {items.map((item, index) => {
          const active = isActiveTab(item, selectedViewId, browser)
          const id = workbenchTabId(item.viewId, item.pageId)
          return (
            <div
              className="workbench-tab"
              key={item.key}
              data-view-id={item.viewId}
              data-tab-key={item.key}
              data-tool={item.contribution.title}
              data-active={active}
            >
              <button
                role="tab"
                title={item.title}
                id={id}
                aria-controls="workbench-active-panel"
                tabIndex={active ? 0 : -1}
                aria-selected={active}
                onClick={() => select(item)}
                onKeyDown={(event) => {
                  const next =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? items.length - 1
                        : event.key === 'ArrowRight'
                          ? (index + 1) % items.length
                          : event.key === 'ArrowLeft'
                            ? (index + items.length - 1) % items.length
                            : -1
                  if (event.key === 'Delete') {
                    event.preventDefault()
                    close(item)
                    return
                  }
                  if (next < 0) return
                  event.preventDefault()
                  select(items[next])
                  root.current
                    ?.querySelector<HTMLElement>(
                      `[data-tab-key="${CSS.escape(items[next].key)}"] [role="tab"]`
                    )
                    ?.focus()
                }}
              >
                {item.pageId ? (
                  item.loading ? (
                    <LoaderCircle className="spin" size={15} aria-hidden="true" />
                  ) : (
                    <Globe2 size={15} aria-hidden="true" />
                  )
                ) : (
                  <Icon contribution={item.contribution} />
                )}
                <span className="workbench-tab-title">{item.title}</span>
                {index < 9 ? (
                  <kbd className="workbench-tab-shortcut" aria-hidden="true">
                    {shortcutLabel(String(index + 1))}
                  </kbd>
                ) : null}
              </button>
              <button
                className="workbench-tab-close"
                aria-label={t('关闭{title}标签', { title: item.title })}
                onClick={() => close(item)}
              >
                <X size={12} />
              </button>
            </div>
          )
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
                onSelect={() => open(contribution)}
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
