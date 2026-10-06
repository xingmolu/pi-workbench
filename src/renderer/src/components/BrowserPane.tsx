import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CircleStop,
  Copy,
  ExternalLink,
  Globe2,
  LockKeyhole,
  MoreHorizontal,
  RefreshCw,
  ShieldCheck
} from 'lucide-react'
import type { BrowserPageSummary, BrowserState, WorkbenchCommand } from '../../../shared/contracts'
import {
  addressTarget,
  browserCommand,
  browserOperate,
  followBrowserState,
  useBrowserState
} from '../store/browser-state'
import { t } from '../../../shared/i18n'

function activePage(state: BrowserState): BrowserPageSummary | undefined {
  return state.pages.find((page) => page.id === state.activePageId)
}

const clamp = (value: number, maximum: number): number =>
  Math.min(maximum, Math.max(0, Math.round(value)))

function isExpectedHideCancellation(message: string): boolean {
  return /superseded|disposed|unavailable|no longer current/i.test(message)
}

/** The workbench browser. Its pages are tabs in the workbench header; this pane holds the
 * toolbar and the native page view. */
export default function BrowserPane({
  viewId,
  projectReady,
  visible: shown = true,
  onWorkbenchCommand,
  onWorkbenchError
}: {
  viewId: string
  projectReady: boolean
  visible?: boolean
  onWorkbenchCommand: (command: WorkbenchCommand) => Promise<void>
  onWorkbenchError: (message: string) => void
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const addressFocused = useRef(false)
  const state = useBrowserState((store) => store.state)
  const clientError = useBrowserState((store) => store.error)
  const [address, setAddress] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  // The native page would cover the menu, so it steps aside while the menu is open.
  const visible = shown && !menuOpen
  const page = useMemo(() => activePage(state), [state])
  const operate = browserOperate
  const command = browserCommand

  useEffect(followBrowserState, [])

  useEffect(() => {
    if (!addressFocused.current) setAddress(page?.url === 'about:blank' ? '' : (page?.url ?? ''))
  }, [page?.url])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    let cancelled = false
    if (!viewport || !projectReady || !visible) {
      void onWorkbenchCommand({ type: 'view:set', viewId, visible: false }).catch(
        (error: unknown) => {
          if (cancelled) return
          const message = error instanceof Error ? error.message : String(error)
          onWorkbenchError(message)
        }
      )
      return () => {
        cancelled = true
      }
    }
    let frame = 0
    const publishBounds = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = viewport.getBoundingClientRect()
        void onWorkbenchCommand({
          type: 'view:set',
          viewId,
          visible: true,
          bounds: {
            x: clamp(rect.x, 100_000),
            y: clamp(rect.y, 100_000),
            width: Math.max(1, clamp(rect.width, 16_384)),
            height: Math.max(1, clamp(rect.height, 16_384))
          }
        }).catch((error: unknown) => {
          if (cancelled) return
          const message = error instanceof Error ? error.message : String(error)
          onWorkbenchError(message)
        })
      })
    }
    const observer = new ResizeObserver(publishBounds)
    observer.observe(viewport)
    // A pixel-sized workbench may move without changing viewport width when
    // the sidebar animates or the window resizes.
    const workspace = viewport.closest('.workspace-panels')
    if (workspace) observer.observe(workspace)
    window.addEventListener('resize', publishBounds)
    publishBounds()
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', publishBounds)
      void onWorkbenchCommand({ type: 'view:set', viewId, visible: false }).catch(
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          if (!isExpectedHideCancellation(message)) onWorkbenchError(message)
        }
      )
    }
  }, [onWorkbenchCommand, onWorkbenchError, projectReady, viewId, visible])

  const notice =
    state.controller === 'agent'
      ? t('Agent 正在控制{value}', { value: state.lastAction ? ` · ${state.lastAction}` : '' })
      : (state.error ?? clientError)
  const webPage = page && /^https?:/.test(page.url) ? page : undefined

  return (
    <div className="browser-pane">
      <form
        className="browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          if (address.trim()) void operate({ action: 'navigate', url: addressTarget(address) })
        }}
      >
        <div className="browser-nav-group">
          <button
            type="button"
            title={t('后退')}
            aria-label={t('浏览器后退')}
            disabled={!page?.canGoBack}
            onClick={() => void operate({ action: 'back' })}
          >
            <ArrowLeft size={15} />
          </button>
          <button
            type="button"
            title={t('前进')}
            aria-label={t('浏览器前进')}
            disabled={!page?.canGoForward}
            onClick={() => void operate({ action: 'forward' })}
          >
            <ArrowRight size={15} />
          </button>
          <span className="browser-nav-divider" aria-hidden="true" />
          <button
            type="button"
            title={t('重新加载')}
            aria-label={t('重新加载页面')}
            disabled={!page}
            onClick={() => void operate({ action: 'reload' })}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <label className={`browser-address${address ? ' has-value' : ''}`}>
          <span className="sr-only">{t('网址')}</span>
          {webPage ? (
            webPage.url.startsWith('https://') ? (
              <LockKeyhole size={12} aria-hidden="true" />
            ) : (
              <Globe2 size={12} aria-hidden="true" />
            )
          ) : null}
          <input
            value={address}
            disabled={!projectReady}
            spellCheck={false}
            placeholder={projectReady ? t('搜索或输入网址') : t('选择工作区后可浏览')}
            onFocus={(event) => {
              addressFocused.current = true
              event.currentTarget.select()
            }}
            onBlur={() => {
              addressFocused.current = false
              setAddress(page?.url === 'about:blank' ? '' : (page?.url ?? ''))
            }}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger className="browser-round-button" aria-label={t('浏览器更多操作')}>
            <MoreHorizontal size={16} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="browser-menu" sideOffset={6} align="end">
              <DropdownMenu.Item
                disabled={!webPage}
                onSelect={() => {
                  if (webPage) void navigator.clipboard.writeText(webPage.url).catch(() => {})
                }}
              >
                <Copy size={14} />
                <span>{t('复制链接')}</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                disabled={!webPage}
                onSelect={() => {
                  if (webPage) window.open(webPage.url, '_blank')
                }}
              >
                <ExternalLink size={14} />
                <span>{t('在系统浏览器中打开')}</span>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="browser-menu-separator" />
              <div className="browser-menu-note">
                <ShieldCheck size={14} aria-hidden="true" />
                <span>{t('独立浏览器资料 · 网页内容不受信任')}</span>
              </div>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </form>

      {notice ? (
        <div
          className={`browser-control${state.controller === 'agent' ? ' is-agent' : ' is-error'}`}
          role="status"
        >
          <span className="browser-control-dot" />
          <span>{notice}</span>
          {state.controller === 'agent' ? (
            <button type="button" onClick={() => void command({ type: 'agent:stop' })}>
              <CircleStop size={12} /> {t('停止')}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="browser-viewport" ref={viewportRef}>
        {!projectReady ? (
          <div className="browser-empty">
            <strong>{t('先选择工作区')}</strong>
            <span>{t('浏览器 profile 会按项目隔离，agent 与你共享当前标签页。')}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
