import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, Globe, RefreshCw, SquareTerminal } from 'lucide-react'
import type { RemoteViewAccess, RemoteViewSummary } from '../../../shared/remote-views'
import type { ResolvedTheme } from '../store/theme'
import { mobileApi } from './api'
import { RemoteBrowserView } from './RemoteBrowserView'
import { RemoteTerminalView } from './RemoteTerminalView'

/** The desktop's browser and terminals, one at a time, under the desktop's access level. */
export function WorkbenchPane({
  viewId,
  theme,
  onSelect,
  onBack
}: {
  viewId: string | undefined
  theme: ResolvedTheme
  onSelect: (viewId: string) => void
  onBack: () => void
}): React.JSX.Element {
  const [access, setAccess] = useState<RemoteViewAccess | null>(null)
  const [views, setViews] = useState<RemoteViewSummary[]>([])
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      const result = await mobileApi.views()
      setAccess(result.access)
      setViews(result.views)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const selected = views.find((view) => view.id === viewId) ?? views[0]
  const control = access === 'control'
  return (
    <>
      <header className="m-top">
        <button type="button" className="m-icon m-back" aria-label="返回" onClick={onBack}>
          <ChevronLeft size={20} />
        </button>
        <h1>电脑工作台</h1>
        <button
          type="button"
          className="m-icon"
          aria-label="刷新视图列表"
          onClick={() => void load()}
        >
          <RefreshCw size={17} />
        </button>
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
      {access && access !== 'off' && views.length === 0 ? (
        <p className="m-empty">电脑上没有可查看的浏览器或终端。请在 Desktop 插件中打开它们。</p>
      ) : null}
      {views.length > 1 ? (
        <nav className="m-views" aria-label="工作台视图">
          {views.map((view) => (
            <button
              type="button"
              key={view.id}
              className={view.id === selected?.id ? 'is-on' : undefined}
              aria-pressed={view.id === selected?.id}
              onClick={() => onSelect(view.id)}
            >
              {view.kind === 'browser' ? <Globe size={14} /> : <SquareTerminal size={14} />}
              <span>{view.title}</span>
              {view.detail ? <small>{view.detail}</small> : null}
            </button>
          ))}
        </nav>
      ) : null}
      {selected?.kind === 'browser' ? (
        <RemoteBrowserView key="browser" control={control} onError={setError} />
      ) : selected?.kind === 'terminal' ? (
        <RemoteTerminalView
          key={selected.id}
          id={selected.id}
          control={control}
          theme={theme}
          onError={setError}
        />
      ) : null}
    </>
  )
}
