import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { RemoteTerminalInput, RemoteTerminalKey } from '../../../shared/remote-views'
import { mobileApi } from './api'
import type { ResolvedTheme } from '../store/theme'

type Event =
  | { type: 'replay'; data: string; cols: number; rows: number; state: string }
  | { type: 'output'; data: string }
  | { type: 'state'; cols: number; rows: number; state: string }

const KEYS: [RemoteTerminalKey, string][] = [
  ['Escape', 'Esc'],
  ['Tab', 'Tab'],
  ['Ctrl-C', '^C'],
  ['Ctrl-D', '^D'],
  ['ArrowUp', '↑'],
  ['ArrowDown', '↓'],
  ['ArrowLeft', '←'],
  ['ArrowRight', '→'],
  ['Ctrl-L', '清屏']
]

const STATE_LABEL: Record<string, string> = {
  starting: '启动中',
  running: '运行中',
  degraded: '连接中断',
  closing: '正在关闭',
  exited: '已结束',
  failed: '已失败'
}

const THEMES = {
  dark: { background: '#111113', foreground: '#e9e9ec', cursor: '#3dd68c' },
  light: { background: '#fbfbfc', foreground: '#1d1d20', cursor: '#1f9d62' }
}

/**
 * The desktop terminal at its own size: the phone never resizes the shell, it scales the font
 * to fit the columns and scrolls sideways when they still do not fit.
 */
export function RemoteTerminalView({
  id,
  control,
  theme,
  onError
}: {
  id: string
  control: boolean
  theme: ResolvedTheme
  onError: (message: string) => void
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const [state, setState] = useState('')
  const [line, setLine] = useState('')

  const send = useCallback(
    (input: RemoteTerminalInput): void => {
      if (!control) return
      void mobileApi
        .viewInput(id, input)
        .catch((reason: unknown) =>
          onError(reason instanceof Error ? reason.message : String(reason))
        )
    },
    [control, id, onError]
  )
  const sendRef = useRef(send)
  sendRef.current = send

  useEffect(() => {
    const element = host.current
    if (!element) return
    const term = new Terminal({
      convertEol: false,
      cursorBlink: control,
      disableStdin: !control,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 12,
      scrollback: 5000,
      theme: THEMES[theme]
    })
    term.open(element)
    terminal.current = term
    const typed = term.onData((data) => sendRef.current({ type: 'text', data }))
    const fit = (cols: number, rows: number): void => {
      const width = element.clientWidth || window.innerWidth
      // Monospace glyphs are about 0.6em wide.
      const size = Math.max(7, Math.min(13, Math.floor(width / (cols * 0.61))))
      term.options.fontSize = size
      term.resize(cols, rows)
    }
    const source = mobileApi.viewEvents(id)
    const on = (name: string, handle: (event: Event) => void): void =>
      source.addEventListener(name, (message) =>
        handle(JSON.parse((message as MessageEvent<string>).data) as Event)
      )
    on('replay', (event) => {
      if (event.type !== 'replay') return
      term.reset()
      fit(event.cols, event.rows)
      term.write(event.data)
      setState(event.state)
    })
    on('output', (event) => {
      if (event.type === 'output') term.write(event.data)
    })
    on('state', (event) => {
      if (event.type !== 'state') return
      if (event.cols !== term.cols || event.rows !== term.rows) fit(event.cols, event.rows)
      setState(event.state)
    })
    source.addEventListener('gone', () => {
      setState('exited')
      source.close()
    })
    return () => {
      source.close()
      typed.dispose()
      term.dispose()
      terminal.current = null
    }
    // The stream belongs to the terminal and the access level, not to theme changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, control])

  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = THEMES[theme]
  }, [theme])

  return (
    <div className="m-rt">
      <div className="m-rb-tools">
        <span className={`m-chip${state === 'running' ? ' is-run' : ''}`}>
          {STATE_LABEL[state] ?? '连接中…'}
        </span>
        {!control ? <span className="m-chip">只读</span> : null}
      </div>
      <div className="m-rt-screen" ref={host} onClick={() => terminal.current?.focus()} />
      {control ? (
        <form
          className="m-rb-keyboard"
          onSubmit={(event) => {
            event.preventDefault()
            send({ type: 'text', data: `${line}\r` })
            setLine('')
          }}
        >
          <div className="m-rb-keys">
            {KEYS.map(([key, label]) => (
              <button type="button" key={key} onClick={() => send({ type: 'key', key })}>
                {label}
              </button>
            ))}
          </div>
          <div className="m-rb-type">
            <input
              aria-label="输入命令"
              placeholder="输入命令，回车执行"
              value={line}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="send"
              onChange={(event) => setLine(event.target.value)}
            />
            <button type="submit" className="m-button is-primary">
              执行
            </button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
