import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ChevronLeft } from 'lucide-react'
import type { MobileConversationSnapshot } from '../../../shared/mobile-gateway'
import { mobileStatusBadge } from '../../../shared/mobile-list'
import { MobileConversation, type Respond } from './MobileConversation'
import { MobileComposer } from './MobileComposer'
import { ThemeButton } from './ThemeButton'
import type { MobileThemeChoice } from './theme'
import { nearBottom } from './flow'
import { mobileApi } from './api'

export function ChatPane({
  snapshot,
  routed,
  host,
  error,
  paused,
  theme,
  onTheme,
  onBack,
  onRefresh,
  onError
}: {
  snapshot: MobileConversationSnapshot | null
  routed: boolean
  host: string
  error: string
  paused: boolean
  theme: MobileThemeChoice
  onTheme: (choice: MobileThemeChoice) => void
  onBack: () => void
  onRefresh: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const scroller = useRef<HTMLElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [unseen, setUnseen] = useState(false)
  const workerId = snapshot?.workerId ?? null
  const pin = useCallback(() => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [])

  // A newly opened session starts at its latest message.
  useLayoutEffect(() => {
    follow.current = true
    setUnseen(false)
    pin()
  }, [workerId, pin])
  // New output follows the reader only while they are at the end; otherwise it is announced.
  useLayoutEffect(() => {
    if (follow.current) pin()
    else setUnseen(true)
  }, [snapshot?.revision, snapshot?.generation, pin])
  // Diffs and highlighted code settle after render; stay pinned while they grow.
  useEffect(() => {
    const element = content.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (follow.current) pin()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [workerId, pin])

  const report = (task: Promise<unknown>): Promise<void> =>
    task.then(
      () => undefined,
      (reason: unknown) => {
        onError(reason instanceof Error ? reason.message : String(reason))
        throw reason
      }
    )
  const respond: Respond = useCallback(
    (approval, allow) =>
      workerId
        ? mobileApi.respond(workerId, approval.id, allow).then(
            () => undefined,
            (reason: unknown) => onError(reason instanceof Error ? reason.message : String(reason))
          )
        : Promise.resolve(),
    [workerId, onError]
  )

  const notices = (
    <>
      {error ? (
        <p className="m-notice is-error" role="alert">
          {error}
        </p>
      ) : null}
      {paused ? (
        <p className="m-notice" role="status">
          内容较大，实时更新已暂停。
          <button id="refresh-snapshot" type="button" className="m-link" onClick={onRefresh}>
            刷新完整内容
          </button>
        </p>
      ) : null}
    </>
  )

  if (!snapshot)
    return (
      <>
        <header className="m-top">
          {routed ? (
            <button type="button" className="m-icon m-back" aria-label="返回" onClick={onBack}>
              <ChevronLeft size={20} />
            </button>
          ) : null}
          <h1>{routed ? '会话' : '对话'}</h1>
          {!routed ? <span className="m-host">{host}</span> : null}
        </header>
        {notices}
        <p className="m-empty">
          {routed ? '正在读取…' : '从左侧选择一个会话，继续同一条桌面对话。'}
        </p>
      </>
    )

  const badge = mobileStatusBadge(snapshot.status)
  return (
    <>
      <header className="m-top">
        <button type="button" className="m-icon m-back" aria-label="返回" onClick={onBack}>
          <ChevronLeft size={20} />
        </button>
        <h1 title={snapshot.title}>{snapshot.title}</h1>
        <span className={`m-pill is-${badge.kind}`}>{badge.label}</span>
        <ThemeButton choice={theme} onChoice={onTheme} />
      </header>
      {notices}
      <main
        className="m-chat-scroll"
        id="chat-scroll"
        ref={scroller}
        onScroll={(event) => {
          follow.current = nearBottom(event.currentTarget)
          if (follow.current) setUnseen(false)
        }}
      >
        <div ref={content}>
          <MobileConversation snapshot={snapshot} respond={respond} />
        </div>
      </main>
      {unseen ? (
        <button
          type="button"
          className="m-jump"
          onClick={() => {
            follow.current = true
            setUnseen(false)
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
          }}
        >
          <ArrowDown size={14} aria-hidden="true" />
          最新内容
        </button>
      ) : null}
      <MobileComposer
        snapshot={snapshot}
        send={(text) => {
          follow.current = true
          return report(mobileApi.send(snapshot, text))
        }}
        abort={() => report(mobileApi.abort(snapshot.workerId)).catch(() => {})}
        clearQueue={() => report(mobileApi.clearQueue(snapshot.workerId)).catch(() => {})}
      />
    </>
  )
}
