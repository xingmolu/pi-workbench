import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CircleStop,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RefreshCw,
  X
} from 'lucide-react'
import type {
  BrowserCommand,
  BrowserOperation,
  BrowserPageSummary,
  BrowserState
} from '../../../shared/contracts'

const EMPTY_BROWSER_STATE: BrowserState = {
  available: false,
  visible: false,
  pages: [],
  activePageId: null,
  controller: 'idle'
}

function activePage(state: BrowserState): BrowserPageSummary | undefined {
  return state.pages.find((page) => page.id === state.activePageId)
}

const clamp = (value: number, maximum: number): number =>
  Math.min(maximum, Math.max(0, Math.round(value)))

function isExpectedHideCancellation(message: string): boolean {
  return /superseded|disposed|unavailable|no longer current/i.test(message)
}

export default function BrowserPane({
  viewId,
  projectReady,
  onWorkbenchError
}: {
  viewId: string
  projectReady: boolean
  onWorkbenchError: (message: string) => void
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const addressFocused = useRef(false)
  const [state, setState] = useState<BrowserState>(EMPTY_BROWSER_STATE)
  const [address, setAddress] = useState('')
  const [clientError, setClientError] = useState<string | null>(null)
  const page = useMemo(() => activePage(state), [state])

  const command = useCallback(async (value: BrowserCommand): Promise<void> => {
    try {
      const result = await window.pi.browser(value)
      setState(result.state)
      setClientError(null)
    } catch (error) {
      setClientError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const operate = useCallback(
    (operation: BrowserOperation): void => void command({ type: 'operate', operation }),
    [command]
  )

  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.pi.onBrowserEvent((event) => {
      if (!cancelled) setState(event.data)
    })
    void window.pi
      .browser({ type: 'state:get' })
      .then((result) => {
        if (!cancelled) setState(result.state)
      })
      .catch((error: unknown) => {
        if (!cancelled) setClientError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!addressFocused.current) setAddress(page?.url === 'about:blank' ? '' : (page?.url ?? ''))
  }, [page?.url])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    let cancelled = false
    if (!viewport || !projectReady) {
      void window.pi
        .workbench({ type: 'view:set', viewId, visible: false })
        .catch((error: unknown) => {
          if (cancelled) return
          const message = error instanceof Error ? error.message : String(error)
          setClientError(message)
          onWorkbenchError(message)
        })
      return () => {
        cancelled = true
      }
    }
    let frame = 0
    const publishBounds = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = viewport.getBoundingClientRect()
        void window.pi
          .workbench({
            type: 'view:set',
            viewId,
            visible: true,
            bounds: {
              x: clamp(rect.x, 100_000),
              y: clamp(rect.y, 100_000),
              width: Math.max(1, clamp(rect.width, 16_384)),
              height: Math.max(1, clamp(rect.height, 16_384))
            }
          })
          .catch((error: unknown) => {
            if (cancelled) return
            const message = error instanceof Error ? error.message : String(error)
            setClientError(message)
            onWorkbenchError(message)
          })
      })
    }
    const observer = new ResizeObserver(publishBounds)
    observer.observe(viewport)
    window.addEventListener('resize', publishBounds)
    publishBounds()
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', publishBounds)
      void window.pi
        .workbench({ type: 'view:set', viewId, visible: false })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          if (!isExpectedHideCancellation(message)) onWorkbenchError(message)
        })
    }
  }, [onWorkbenchError, projectReady, viewId])

  return (
    <div className="browser-pane">
      <div className="browser-tabs" role="tablist" aria-label="浏览器标签页">
        {state.pages.map((tab) => (
          <div className={`browser-tab${tab.active ? ' is-active' : ''}`} key={tab.id}>
            <button
              type="button"
              role="tab"
              aria-selected={tab.active}
              title={tab.title || tab.url}
              onClick={() => operate({ action: 'select_tab', pageId: tab.id })}
            >
              {tab.loading ? (
                <LoaderCircle className="spin" size={12} />
              ) : (
                <span className="tab-dot" />
              )}
              <span>{tab.title || '新标签页'}</span>
            </button>
            <button
              className="browser-tab-close"
              type="button"
              title="关闭标签页"
              aria-label={`关闭 ${tab.title || '标签页'}`}
              onClick={() => operate({ action: 'close_tab', pageId: tab.id })}
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <button
          className="browser-new-tab"
          type="button"
          title="新建标签页"
          aria-label="新建浏览器标签页"
          disabled={!projectReady}
          onClick={() => operate({ action: 'new_tab' })}
        >
          <Plus size={14} />
        </button>
      </div>

      <form
        className="browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          if (address.trim()) operate({ action: 'navigate', url: address.trim() })
        }}
      >
        <div className="browser-nav-group">
          <button
            type="button"
            title="后退"
            aria-label="浏览器后退"
            disabled={!page?.canGoBack}
            onClick={() => operate({ action: 'back' })}
          >
            <ArrowLeft size={14} />
          </button>
          <button
            type="button"
            title="前进"
            aria-label="浏览器前进"
            disabled={!page?.canGoForward}
            onClick={() => operate({ action: 'forward' })}
          >
            <ArrowRight size={14} />
          </button>
          <button
            type="button"
            title="重新加载"
            aria-label="重新加载页面"
            disabled={!page}
            onClick={() => operate({ action: 'reload' })}
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <label className="browser-address">
          <span className="sr-only">网址</span>
          {page?.url.startsWith('https://') ? <LockKeyhole size={11} /> : <Globe2 size={11} />}
          <input
            value={address}
            disabled={!projectReady}
            spellCheck={false}
            placeholder={projectReady ? '输入网址' : '选择工作区后可浏览'}
            onFocus={() => {
              addressFocused.current = true
            }}
            onBlur={() => {
              addressFocused.current = false
              setAddress(page?.url === 'about:blank' ? '' : (page?.url ?? ''))
            }}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
      </form>

      <div className={`browser-control${state.controller === 'agent' ? ' is-agent' : ''}`}>
        <span className="browser-control-dot" />
        <span>
          {state.controller === 'agent'
            ? `Agent 正在控制${state.lastAction ? ` · ${state.lastAction}` : ''}`
            : state.error || clientError || '独立浏览器资料 · 网页内容不受信任'}
        </span>
        {state.controller === 'agent' ? (
          <button type="button" onClick={() => void command({ type: 'agent:stop' })}>
            <CircleStop size={12} /> 停止
          </button>
        ) : null}
      </div>

      <div className="browser-viewport" ref={viewportRef}>
        {!projectReady ? (
          <div className="browser-empty">
            <strong>先选择工作区</strong>
            <span>浏览器 profile 会按项目隔离，agent 与你共享当前标签页。</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
