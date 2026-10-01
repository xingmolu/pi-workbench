import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Globe, Puzzle, RefreshCw, SquareTerminal } from 'lucide-react'
import type {
  MobilePluginView,
  RemoteViewAccess,
  RemoteViewSummary
} from '../../../shared/remote-views'
import type { ResolvedTheme } from '../store/theme'
import { mobileApi } from './api'
import { PluginFrameView } from './PluginFrameView'
import { RemoteBrowserView } from './RemoteBrowserView'
import { RemoteTerminalView } from './RemoteTerminalView'

/** Route ids for plugin pages; browser and terminals keep their own ids. */
const PLUGIN = 'plugin:'

type Tab = {
  id: string
  title: string
  detail?: string
  kind: 'plugin' | 'browser' | 'terminal'
  available: boolean
}

function tabs(views: RemoteViewSummary[], plugins: MobilePluginView[]): Tab[] {
  return [
    ...plugins.map((view) => ({
      id: `${PLUGIN}${view.id}`,
      title: view.title,
      detail: view.available ? view.pluginName : '需要电脑上打开一个项目',
      kind: 'plugin' as const,
      available: view.available
    })),
    ...views.map((view) => ({
      id: view.id,
      title: view.title,
      ...(view.detail ? { detail: view.detail } : {}),
      kind: view.kind,
      available: true
    }))
  ]
}

function TabIcon({ kind }: { kind: Tab['kind'] }): React.JSX.Element {
  if (kind === 'browser') return <Globe size={18} />
  if (kind === 'terminal') return <SquareTerminal size={18} />
  return <Puzzle size={18} />
}

/**
 * The desktop's tabs the phone can open: plugin pages that declared the phone surface, the
 * browser and terminals. One at a time, under the desktop's remote access level.
 */
export function WorkbenchPane({
  viewId,
  theme,
  onSelect,
  onBack
}: {
  viewId: string | undefined
  theme: ResolvedTheme
  onSelect: (viewId?: string) => void
  onBack: () => void
}): React.JSX.Element {
  const [access, setAccess] = useState<RemoteViewAccess | null>(null)
  const [items, setItems] = useState<Tab[]>([])
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      const [views, plugins] = await Promise.all([
        mobileApi.views(),
        mobileApi.plugins().catch(() => ({ access: 'off' as const, views: [] }))
      ])
      setAccess(views.access)
      setItems(tabs(views.views, plugins.views))
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const selected = viewId ? items.find((item) => item.id === viewId) : undefined
  const control = access === 'control'
  return (
    <>
      <header className="m-top">
        <button
          type="button"
          className="m-icon m-back"
          aria-label="返回"
          onClick={() => (viewId ? onSelect() : onBack())}
        >
          <ChevronLeft size={20} />
        </button>
        <h1>{selected?.title ?? '打开标签页'}</h1>
        {!viewId ? (
          <button
            type="button"
            className="m-icon"
            aria-label="刷新标签页列表"
            onClick={() => void load()}
          >
            <RefreshCw size={17} />
          </button>
        ) : (
          <span className="m-icon" aria-hidden="true" />
        )}
      </header>
      {error ? (
        <p className="m-notice is-error" role="alert">
          {error}
        </p>
      ) : null}
      {access === 'off' ? (
        <p className="m-empty">
          电脑没有开放远程工作台。请在电脑上打开「设置 › 手机 ›
          远程工作台」，选择「只看」或「可操作」。
        </p>
      ) : null}

      {!viewId && access && access !== 'off' ? (
        items.length ? (
          <nav className="m-tabs" aria-label="电脑上的标签页">
            <p className="m-tabs-note">
              {control ? '可以在手机上操作这些标签页。' : '电脑只允许查看，操作需要在电脑上开启。'}
            </p>
            {items.map((item) => (
              <button
                type="button"
                key={item.id}
                className="m-tab"
                disabled={!item.available}
                onClick={() => onSelect(item.id)}
              >
                <span className={`m-tab-icon is-${item.kind}`}>
                  <TabIcon kind={item.kind} />
                </span>
                <span className="m-tab-text">
                  <strong>{item.title}</strong>
                  {item.detail ? <small>{item.detail}</small> : null}
                </span>
                <ChevronRight size={16} className="m-tab-chevron" />
              </button>
            ))}
          </nav>
        ) : (
          <p className="m-empty">
            电脑上没有可以在手机打开的标签页。在 Desktop 插件中启用 Git、浏览器或终端后再试。
          </p>
        )
      ) : null}

      {viewId?.startsWith(PLUGIN) ? (
        <PluginFrameView key={viewId} viewId={viewId.slice(PLUGIN.length)} onError={setError} />
      ) : selected?.kind === 'browser' ? (
        <RemoteBrowserView key="browser" control={control} onError={setError} />
      ) : selected?.kind === 'terminal' ? (
        <RemoteTerminalView
          key={selected.id}
          id={selected.id}
          control={control}
          theme={theme}
          onError={setError}
        />
      ) : viewId && access && access !== 'off' && items.length ? (
        <p className="m-empty">这个标签页已经关闭。</p>
      ) : null}
    </>
  )
}
