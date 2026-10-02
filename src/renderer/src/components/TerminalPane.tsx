import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ClipboardPaste,
  MessageSquarePlus,
  Plus,
  Search,
  TerminalSquare,
  X
} from 'lucide-react'
import { TerminalController, pastePreview, terminalKey } from './terminal-controller'
import { useResolvedTheme } from '../store/theme'
import { useComposerPrefill } from '../store/composer-prefill'
import { useOverlayState } from '../store/overlay-state'
import { shortcutLabel } from './shortcut-label'
import { t } from '../../../shared/i18n'
import '@xterm/xterm/css/xterm.css'

const states = {
  starting: t('启动中'),
  running: t('运行中'),
  exited: t('已退出'),
  failed: t('失败'),
  degraded: t('屏幕未恢复'),
  closing: t('结束中')
}
export default function TerminalPane({
  projectPath,
  visible
}: {
  projectPath: string | null
  visible: boolean
}): React.JSX.Element {
  const theme = useResolvedTheme()
  const stage = useRef<HTMLDivElement>(null)
  const pane = useRef<HTMLElement>(null)
  const newButton = useRef<HTMLButtonElement>(null)
  const focusReturn = useRef<HTMLButtonElement | null>(null)
  const controller = useRef<TerminalController | null>(null)
  const focusRequest = useRef<{
    controller: TerminalController
    revision: number
    projectPath: string | null
  } | null>(null)
  const [, render] = useReducer((n: number) => n + 1, 0)
  const [query, setQuery] = useState('')
  const [missing, setMissing] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const instance = new TerminalController(stage.current!, render, {
      openFile: (project, path) => useOverlayState.getState().requestFileOpen(project, path)
    })
    controller.current = instance
    void instance.context(projectPath, visible)
    return () => {
      instance.dispose()
      controller.current = null
    }
  }, [])
  useEffect(() => {
    void controller.current?.context(projectPath, visible)
  }, [projectPath, visible])
  useEffect(() => {
    controller.current?.setTheme(theme)
  }, [theme])
  const c = controller.current
  const entries = c?.entries.filter((e) => e.metadata.projectPath === projectPath) ?? []
  const current = c?.current
  const metadata = current?.metadata
  const prompt = c?.prompt
  const background =
    c?.entries.filter((e) => e.metadata.projectPath !== projectPath && !e.metadata.exitConfirmed)
      .length ?? 0
  const degraded = metadata?.connection === 'management' && !metadata.exitConfirmed
  // A frame callback may run before React commits the enabled toolbar. Restore only
  // after this render's DOM commit, while the original interaction still owns focus.
  useLayoutEffect(() => {
    const request = focusRequest.current
    if (!request) return
    focusRequest.current = null
    const owner = request.controller
    if (
      owner !== controller.current ||
      request.projectPath !== projectPath ||
      !visible ||
      pane.current?.hidden ||
      owner.interactionRevision !== request.revision ||
      owner.busy ||
      owner.prompt
    )
      return
    owner.focus()
    if (stage.current?.contains(document.activeElement)) return
    const target = focusReturn.current
    if (target?.isConnected && !target.disabled && target.getClientRects().length) target.focus()
    else if (newButton.current && !newButton.current.disabled) newButton.current.focus()
  })
  const searchOpen = Boolean(c?.searchOpen)
  useEffect(() => {
    if (searchOpen) searchInput.current?.select()
  }, [searchOpen])
  const find = (backwards = false): void => {
    if (!c) return
    setMissing(query !== '' && !c.find(query, backwards))
  }
  const selection = c?.selectionText() ?? ''
  const addToChat = (): void => {
    const text = selection.replace(/\s+$/u, '')
    if (!text) return
    const clipped = text.length > 8000 ? text.slice(-8000) : text
    const fence = clipped.includes('```') ? '~~~' : '```'
    const heading =
      text.length > clipped.length ? t('终端输出（末尾 8000 字符）：') : t('终端输出：')
    useComposerPrefill.getState().request(`${heading}\n${fence}\n${clipped}\n${fence}`, 'append')
  }
  const closeTerminal = (recreate = false): void => {
    if (!c) return
    const revision = c.interactionRevision
    // An idle shell closes without a prompt; focus returns as it would after confirming.
    void c.requestClose(recreate)?.then(() => restoreFocus(revision))
  }
  const restoreFocus = (revision: number): void => {
    if (!c || controller.current !== c) return
    focusRequest.current = { controller: c, revision, projectPath }
    render()
  }
  const cancel = (): void => {
    if (!c) return
    const revision = c.interactionRevision
    c.cancel()
    restoreFocus(revision)
  }
  const confirm = async (): Promise<void> => {
    if (!c) return
    const revision = c.interactionRevision
    await c.confirm()
    restoreFocus(revision)
  }
  return (
    <section ref={pane} className="terminal-pane" hidden={!visible} aria-label={t('用户终端')}>
      <div className="terminal-toolbar">
        <div className="terminal-tabs" role="tablist" aria-label={t('项目终端')}>
          {entries.map((entry) => (
            <button
              type="button"
              role="tab"
              key={terminalKey(entry.metadata)}
              aria-selected={entry === current}
              title={entry.title || t('终端 {ordinal}', { ordinal: entry.ordinal })}
              onClick={() => c?.select(entry)}
            >
              <span className={`terminal-state-dot is-${entry.metadata.state}`} />
              <span>{entry.title || t('终端 {ordinal}', { ordinal: entry.ordinal })}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('新建终端')}
          ref={newButton}
          title={t('新建终端')}
          disabled={!projectPath || c?.busy}
          onClick={() => void c?.create()}
        >
          <Plus size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('搜索终端')}
          title={t('搜索终端（{value}）', { value: shortcutLabel('F') })}
          aria-pressed={searchOpen}
          disabled={!c?.currentHasScreen}
          onClick={() => (searchOpen ? c?.closeSearch() : c?.openSearch())}
        >
          <Search size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('添加到对话')}
          title={selection ? t('把选中的终端输出添加到对话') : t('先选中终端里的文字')}
          disabled={!selection}
          onClick={addToChat}
        >
          <MessageSquarePlus size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('粘贴到终端')}
          title={t('粘贴到终端')}
          disabled={!metadata || degraded || metadata.exitConfirmed || c?.busy}
          onClick={() => {
            const identity = current && terminalKey(current.metadata)
            const revision = c?.interactionRevision
            void navigator.clipboard
              .readText()
              .then((text) => {
                if (
                  c?.current &&
                  c.interactionRevision === revision &&
                  terminalKey(c.current.metadata) === identity
                )
                  c.requestPaste(text)
              })
              .catch(() => {
                if (c) {
                  c.error = t('无法读取剪贴板，请使用粘贴快捷键。')
                  render()
                }
              })
          }}
        >
          <ClipboardPaste size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('关闭终端')}
          title={t('关闭终端')}
          disabled={!metadata || c?.busy || metadata.state === 'closing'}
          onClick={(event) => {
            focusReturn.current = event.currentTarget
            closeTerminal()
          }}
        >
          <X size={15} />
        </button>
      </div>
      {searchOpen ? (
        <div className="terminal-search" role="search">
          <Search size={13} aria-hidden="true" />
          <input
            ref={searchInput}
            aria-label={t('在终端中搜索')}
            placeholder={t('搜索')}
            value={query}
            aria-invalid={missing}
            onChange={(event) => {
              setQuery(event.target.value)
              setMissing(event.target.value !== '' && !c?.find(event.target.value))
            }}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') {
                event.preventDefault()
                find(event.shiftKey)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                c?.closeSearch()
              }
            }}
          />
          {missing ? <span className="terminal-search-status">{t('无匹配')}</span> : null}
          <button
            type="button"
            className="icon-btn"
            aria-label={t('上一个匹配')}
            onClick={() => find(true)}
          >
            <ArrowUp size={13} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('下一个匹配')}
            onClick={() => find()}
          >
            <ArrowDown size={13} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('关闭搜索')}
            onClick={() => c?.closeSearch()}
          >
            <X size={13} />
          </button>
        </div>
      ) : null}
      <div className="terminal-trust-note">
        {t(
          '本机用户 shell · 不受 Agent 审批 · 只有你选择“添加到对话”的内容才会发给模型 ·{value} {value2}点击打开链接和文件',
          { value: ' ', value2: shortcutLabel('') }
        )}
      </div>
      {c?.error ? (
        <div className="terminal-notice is-error" role="alert">
          {c.error}
        </div>
      ) : null}
      {current?.pendingDismiss ? (
        <div className="terminal-notice" role="status">
          {t(
            'Shell 已退出，关闭记录待同步；此屏幕仍计入 8 个终端上限。返回所属项目会继续完成关闭。'
          )}
        </div>
      ) : null}
      {!projectPath ? (
        <div className="terminal-empty">
          <TerminalSquare size={22} />
          <strong>{t('先选择工作区')}</strong>
          <p>{t('新终端将从所选项目目录启动。')}</p>
        </div>
      ) : !entries.length ? (
        <div className="terminal-empty">
          <TerminalSquare size={22} />
          <strong>{t('尚未创建终端')}</strong>
          <p>{t('点击右上角 +，启动独立的本机 shell。无需登录 Pi。')}</p>
          <small>{t('项目目录不限制 shell 的文件访问权限。')}</small>
        </div>
      ) : null}
      {degraded ? (
        <div className="terminal-notice terminal-recovery" role="status">
          <strong>{t('终端进程仍在，屏幕状态未恢复')}</strong>
          <p>{t('窗口已重新加载。为避免残缺屏幕影响交互，此终端仅可管理；不会自动重跑命令。')}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={c?.busy || metadata?.state === 'closing'}
            onClick={(event) => {
              focusReturn.current = event.currentTarget
              closeTerminal(true)
            }}
          >
            {t('结束并新建')}
          </button>
        </div>
      ) : metadata?.exitConfirmed || metadata?.failure ? (
        <div className="terminal-notice" role="status">
          <strong>
            {metadata.failure
              ? t('终端失败（{failure}）', { failure: metadata.failure })
              : t('Shell 已退出（退出码 {code}）', { code: metadata.exitCode ?? t('未知') })}
          </strong>
          <p>
            {metadata.exitConfirmed
              ? c?.currentHasScreen
                ? t('屏幕保留供查看；新终端不会重放命令。')
                : t('历史屏幕未恢复；新终端不会重放命令。')
              : t('尚未确认 shell 退出，请先结束终端。')}
          </p>
          <button
            type="button"
            className="secondary-button"
            disabled={c?.busy}
            onClick={(event) => {
              focusReturn.current = event.currentTarget
              closeTerminal(true)
            }}
          >
            {metadata.exitConfirmed ? t('新建替代终端') : t('结束并新建')}
          </button>
        </div>
      ) : null}
      <div className="terminal-emulator-stage" ref={stage} />
      {metadata ? (
        <footer className="terminal-status">
          <span>{states[metadata.state]}</span>
          <span title={metadata.projectPath}>{metadata.projectPath}</span>
        </footer>
      ) : null}
      {background ? (
        <div className="terminal-background-note">
          {t('其他项目仍有 {background} 个终端未结束', { background })}
        </div>
      ) : null}
      {prompt ? (
        <div
          className="terminal-confirmation"
          role="dialog"
          aria-modal="true"
          aria-label={prompt.kind === 'paste' ? t('确认粘贴') : t('确认结束终端')}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') {
              event.preventDefault()
              cancel()
            }
            if (event.key === 'Tab') {
              event.preventDefault()
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
              ]
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
              buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus()
            }
          }}
        >
          <strong>
            {prompt.kind === 'paste' ? t('粘贴内容含换行或控制字符') : t('结束这个终端？')}
          </strong>
          <p>
            {prompt.kind === 'paste'
              ? t('以下内容可能立即执行命令。确认后才会发送。')
              : t('这会终止 shell 和常规任务。已脱离终端的后台进程不保证结束。')}
          </p>
          {prompt.kind === 'paste' ? (
            <pre>{pastePreview(prompt.text ?? '')}</pre>
          ) : (
            <code>{prompt.identity.projectPath}</code>
          )}
          <div>
            <button autoFocus type="button" className="secondary-button" onClick={cancel}>
              {t('取消')}
            </button>
            <button type="button" className="primary-button" onClick={() => void confirm()}>
              {prompt.kind === 'paste'
                ? t('确认粘贴')
                : prompt.kind === 'recreate'
                  ? t('确认结束并新建')
                  : t('确认结束')}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
