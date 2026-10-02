import { useEffect, useRef, useState } from 'react'
import type { PluginPanelContext } from '../../../shared/workbench-contracts'
import { mobileApi } from './api'
import { Sheet } from './Sheet'
import { t } from '../../../shared/i18n'

type Confirmation = { title: string; detail: string; answer: (allow: boolean) => void }

const sameContext = (left: PluginPanelContext | null, right: PluginPanelContext): boolean =>
  !!left &&
  left.projectPath === right.projectPath &&
  left.sessionId === right.sessionId &&
  left.generation === right.generation

/**
 * A plugin page that opted into the phone. It runs in an opaque-origin frame; its
 * `window.piPlugin` calls arrive here by `postMessage` and go to the desktop with this
 * device's credentials. Anything the desktop would confirm is confirmed here first.
 */
export function PluginFrameView({
  viewId,
  onError
}: {
  viewId: string
  onError: (message: string) => void
}): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  const context = useRef<PluginPanelContext | null>(null)
  const [url, setUrl] = useState('')
  const [toast, setToast] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)

  useEffect(() => {
    let live = true
    setUrl('')
    context.current = null
    void mobileApi
      .openPlugin(viewId)
      .then((result) => {
        if (!live) return
        context.current = result.context
        setUrl(result.url)
      })
      .catch((reason: unknown) => live && onError(String((reason as Error)?.message ?? reason)))
    return () => {
      live = false
    }
  }, [viewId, onError])

  useEffect(() => {
    if (!url) return
    const post = (message: Record<string, unknown>): void =>
      frame.current?.contentWindow?.postMessage({ source: 'pi-host', ...message }, '*')
    const ask = (title: string, detail: string): Promise<boolean> =>
      new Promise((resolve) => setConfirmation({ title, detail, answer: resolve }))
    const call = async (method: string, params: unknown): Promise<Record<string, unknown>> => {
      // Toasts belong on the screen the user is looking at.
      if (method === 'ui.showToast' || method === 'ui.notify') {
        const message = (params as { message?: unknown })?.message
        if (typeof message === 'string') setToast(message.slice(0, 500))
        return { ok: true }
      }
      let result = await mobileApi.pluginCall(viewId, method, params)
      if (!result.ok && 'confirm' in result) {
        if (!(await ask(result.confirm.title, result.confirm.detail)))
          return { ok: false, code: 'PERMISSION_DENIED', message: t('用户拒绝了这次操作') }
        result = await mobileApi.pluginCall(viewId, method, params, result.confirm.token)
      }
      if (result.ok) return { ok: true, value: result.value }
      if ('confirm' in result)
        return { ok: false, code: 'PERMISSION_DENIED', message: t('确认已过期，请重试') }
      return { ok: false, code: result.code, message: result.message }
    }
    const receive = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow) return
      const data = event.data as { source?: unknown; id?: unknown; type?: unknown } | null
      if (!data || data.source !== 'pi-plugin' || typeof data.id !== 'number') return
      const id = data.id
      if (data.type === 'context') {
        post({ id, ok: true, value: context.current })
        return
      }
      if (data.type !== 'call') return
      const { method, params } = data as { method?: unknown; params?: unknown }
      if (typeof method !== 'string') {
        post({ id, ok: false, code: 'INVALID_ARGUMENT', message: t('参数无效') })
        return
      }
      void call(method, params)
        .then((reply) => post({ id, ...reply }))
        .catch((reason: unknown) =>
          post({
            id,
            ok: false,
            code: 'UNAVAILABLE',
            message: reason instanceof Error ? reason.message : t('电脑没有响应')
          })
        )
    }
    window.addEventListener('message', receive)
    // The desktop's project can change under the page; tell it the way the desktop does.
    const timer = setInterval(() => {
      if (document.hidden) return
      void mobileApi
        .pluginContext(viewId)
        .then(({ context: next }) => {
          if (sameContext(context.current, next)) return
          context.current = next
          post({ type: 'context', context: next })
        })
        .catch(() => undefined)
    }, 5000)
    return () => {
      window.removeEventListener('message', receive)
      clearInterval(timer)
    }
  }, [url, viewId])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  const settle = (allow: boolean): void => {
    confirmation?.answer(allow)
    setConfirmation(null)
  }

  return (
    <div className="m-plugin">
      {url ? (
        <iframe
          ref={frame}
          className="m-plugin-frame"
          title={viewId}
          src={url}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
        />
      ) : (
        <p className="m-empty">{t('正在打开…')}</p>
      )}
      {toast ? (
        <p className="m-plugin-toast" role="status">
          {toast}
        </p>
      ) : null}
      {confirmation ? (
        <Sheet title={t('确认操作')} onClose={() => settle(false)}>
          <div className="m-plugin-confirm">
            <strong>{confirmation.title}</strong>
            {confirmation.detail ? <pre>{confirmation.detail}</pre> : null}
            <p className="m-sheet-note">{t('这会在电脑上执行。')}</p>
            <div className="m-plugin-confirm-actions">
              <button type="button" className="m-button" onClick={() => settle(false)}>
                {t('取消')}
              </button>
              <button type="button" className="m-button is-primary" onClick={() => settle(true)}>
                {t('允许')}
              </button>
            </div>
          </div>
        </Sheet>
      ) : null}
    </div>
  )
}
