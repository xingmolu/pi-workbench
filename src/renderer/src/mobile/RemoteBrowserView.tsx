import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Keyboard,
  Layers,
  Monitor,
  Plus,
  RotateCw,
  Smartphone,
  X
} from 'lucide-react'
import type {
  RemoteBrowserFrame,
  RemoteBrowserInput,
  RemoteBrowserState
} from '../../../shared/remote-views'
import { mobileApi } from './api'
import { Sheet } from './Sheet'
import { t } from '../../../shared/i18n'

const KEYS = [
  ['Enter', t('回车')],
  ['Backspace', t('删除')],
  ['Tab', 'Tab'],
  ['Escape', 'Esc'],
  ['ArrowUp', '↑'],
  ['ArrowDown', '↓'],
  ['ArrowLeft', '←'],
  ['ArrowRight', '→']
] as const

/** A tap moves less than this many screen pixels; more is a scroll. */
const TAP_SLOP = 8

export function RemoteBrowserView({
  control,
  onError
}: {
  control: boolean
  onError: (message: string) => void
}): React.JSX.Element {
  const [frame, setFrame] = useState<RemoteBrowserFrame | null>(null)
  const [state, setState] = useState<RemoteBrowserState | null>(null)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [tabs, setTabs] = useState(false)
  const [keyboard, setKeyboard] = useState(false)
  const [text, setText] = useState('')
  const [connected, setConnected] = useState(false)
  const image = useRef<HTMLImageElement>(null)

  useEffect(() => {
    const source = mobileApi.viewEvents('browser')
    source.addEventListener('open', () => setConnected(true))
    source.addEventListener('error', () => setConnected(false))
    source.addEventListener('frame', (event) =>
      setFrame(JSON.parse((event as MessageEvent<string>).data) as RemoteBrowserFrame)
    )
    source.addEventListener('state', (event) =>
      setState(JSON.parse((event as MessageEvent<string>).data) as RemoteBrowserState)
    )
    source.addEventListener('gone', () => source.close())
    return () => source.close()
  }, [])

  const active = state?.tabs.find((tab) => tab.active)
  useEffect(() => {
    if (!editing) setAddress(active?.url && active.url !== 'about:blank' ? active.url : '')
  }, [active?.url, editing])

  const send = useCallback(
    (input: RemoteBrowserInput): void => {
      if (!control) return
      void mobileApi
        .viewInput('browser', input)
        .catch((reason: unknown) =>
          onError(reason instanceof Error ? reason.message : String(reason))
        )
    },
    [control, onError]
  )

  // Touch: a short press is a click, a drag scrolls the page, both in the frame's CSS pixels.
  const gesture = useRef<{
    x: number
    y: number
    lastY: number
    lastX: number
    moved: boolean
  } | null>(null)
  const pending = useRef({ dx: 0, dy: 0, x: 0, y: 0, timer: 0 })
  const point = (
    clientX: number,
    clientY: number
  ): { x: number; y: number; scale: number } | null => {
    const element = image.current
    if (!element || !frame) return null
    const rect = element.getBoundingClientRect()
    const scale = rect.width / frame.width
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale, scale }
  }
  const flushScroll = (): void => {
    const next = pending.current
    next.timer = 0
    if (!next.dx && !next.dy) return
    send({ type: 'scroll', x: next.x, y: next.y, dx: next.dx, dy: next.dy })
    next.dx = next.dy = 0
  }

  const loading = state?.tabs.some((tab) => tab.active && tab.loading)
  return (
    <div className="m-rb">
      <div className="m-rb-bar">
        <button
          type="button"
          className="m-icon"
          aria-label={t('后退')}
          disabled={!control || !state?.canGoBack}
          onClick={() => send({ type: 'back' })}
        >
          <ArrowLeft size={18} />
        </button>
        <button
          type="button"
          className="m-icon"
          aria-label={t('前进')}
          disabled={!control || !state?.canGoForward}
          onClick={() => send({ type: 'forward' })}
        >
          <ArrowRight size={18} />
        </button>
        <form
          className="m-rb-address"
          onSubmit={(event) => {
            event.preventDefault()
            const url = address.trim()
            if (url) send({ type: 'navigate', url })
            setEditing(false)
            ;(document.activeElement as HTMLElement | null)?.blur()
          }}
        >
          <input
            aria-label={t('网址')}
            value={address}
            readOnly={!control}
            placeholder={t('输入网址，例如 localhost:5173')}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onChange={(event) => setAddress(event.target.value)}
          />
        </form>
        <button
          type="button"
          className={`m-icon${loading ? ' m-spin' : ''}`}
          aria-label={t('刷新')}
          disabled={!control}
          onClick={() => send({ type: 'reload' })}
        >
          <RotateCw size={17} />
        </button>
      </div>
      <div className="m-rb-tools">
        <button
          type="button"
          className="m-chip-button"
          aria-label={t('标签页：{value} 个', { value: state?.tabs.length ?? 0 })}
          onClick={() => setTabs(true)}
        >
          <Layers size={13} aria-hidden="true" />
          {state?.tabs.length ?? 0}
        </button>
        <button
          type="button"
          className={`m-chip-button${state?.mobile ? ' is-on' : ''}`}
          aria-pressed={Boolean(state?.mobile)}
          disabled={!control}
          onClick={() => send({ type: 'device', mobile: !state?.mobile })}
        >
          {state?.mobile ? <Smartphone size={13} /> : <Monitor size={13} />}
          {state?.mobile ? t('手机尺寸') : t('电脑尺寸')}
        </button>
        {control ? (
          <button
            type="button"
            className={`m-chip-button${keyboard ? ' is-on' : ''}`}
            aria-pressed={keyboard}
            onClick={() => setKeyboard(!keyboard)}
          >
            <Keyboard size={13} aria-hidden="true" />

            {t('输入')}
          </button>
        ) : (
          <span className="m-chip">{t('只读')}</span>
        )}
        {state?.controller === 'agent' ? (
          <span className="m-chip is-run">{t('Agent 正在操作')}</span>
        ) : null}
        {!connected ? <span className="m-chip is-warn">{t('连接中…')}</span> : null}
      </div>
      {state?.message ? (
        <p className="m-notice" role="status">
          {state.message}
          {control && state.available ? (
            <button type="button" className="m-link" onClick={() => send({ type: 'wake' })}>
              {t('在电脑上显示')}
            </button>
          ) : null}
        </p>
      ) : null}
      <div className="m-rb-stage">
        {frame ? (
          <img
            ref={image}
            className="m-rb-frame"
            src={`data:image/jpeg;base64,${frame.data}`}
            alt={active?.title || t('电脑上的浏览器画面')}
            draggable={false}
            style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
            onPointerDown={(event) => {
              if (!control) return
              event.currentTarget.setPointerCapture(event.pointerId)
              gesture.current = {
                x: event.clientX,
                y: event.clientY,
                lastX: event.clientX,
                lastY: event.clientY,
                moved: false
              }
            }}
            onPointerMove={(event) => {
              const current = gesture.current
              if (!current) return
              if (
                Math.abs(event.clientX - current.x) > TAP_SLOP ||
                Math.abs(event.clientY - current.y) > TAP_SLOP
              )
                current.moved = true
              if (!current.moved) return
              const at = point(event.clientX, event.clientY)
              if (!at) return
              const next = pending.current
              next.dx += -(event.clientX - current.lastX) / at.scale
              next.dy += -(event.clientY - current.lastY) / at.scale
              next.x = at.x
              next.y = at.y
              current.lastX = event.clientX
              current.lastY = event.clientY
              if (!next.timer) next.timer = window.setTimeout(flushScroll, 60)
            }}
            onPointerUp={(event) => {
              const current = gesture.current
              gesture.current = null
              if (!current) return
              if (current.moved) {
                flushScroll()
                return
              }
              const at = point(event.clientX, event.clientY)
              if (at) send({ type: 'tap', x: at.x, y: at.y })
            }}
            onPointerCancel={() => {
              gesture.current = null
            }}
          />
        ) : (
          <p className="m-empty">{connected ? t('等待电脑上的画面…') : t('正在连接…')}</p>
        )}
      </div>
      {keyboard && control ? (
        <form
          className="m-rb-keyboard"
          onSubmit={(event) => {
            event.preventDefault()
            if (text) send({ type: 'text', text })
            setText('')
          }}
        >
          <div className="m-rb-type">
            <input
              aria-label={t('输入到网页')}
              placeholder={t('先点网页里的输入框，再在这里输入')}
              value={text}
              enterKeyHint="send"
              onChange={(event) => setText(event.target.value)}
            />
            <button type="submit" className="m-button is-primary" disabled={!text}>
              {t('发送')}
            </button>
          </div>
          <div className="m-rb-keys">
            {KEYS.map(([key, label]) => (
              <button type="button" key={key} onClick={() => send({ type: 'key', key })}>
                {label}
              </button>
            ))}
          </div>
        </form>
      ) : null}
      {tabs ? (
        <Sheet title={t('标签页')} onClose={() => setTabs(false)}>
          {(state?.tabs ?? []).map((tab) => (
            <div key={tab.id} className={`m-option${tab.active ? ' is-on' : ''}`}>
              <button
                type="button"
                className="m-option-text m-rb-tab"
                disabled={!control}
                onClick={() => {
                  send({ type: 'select_tab', pageId: tab.id })
                  setTabs(false)
                }}
              >
                <strong>{tab.title || t('新标签页')}</strong>
                <small>{tab.url}</small>
              </button>
              {control ? (
                <button
                  type="button"
                  className="m-icon"
                  aria-label={t('关闭 {title}', { title: tab.title || t('标签页') })}
                  onClick={() => send({ type: 'close_tab', pageId: tab.id })}
                >
                  <X size={16} />
                </button>
              ) : null}
            </div>
          ))}
          {control ? (
            <button
              type="button"
              className="m-option"
              onClick={() => {
                send({ type: 'new_tab' })
                setTabs(false)
              }}
            >
              <Plus size={18} aria-hidden="true" />
              <span className="m-option-text">
                <strong>{t('新标签页')}</strong>
              </span>
            </button>
          ) : null}
        </Sheet>
      ) : null}
    </div>
  )
}
