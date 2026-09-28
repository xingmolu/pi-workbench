import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import type { MobileConversationSnapshot } from '../../../shared/mobile-gateway'
import { composeBlockChip, composerShouldSend } from '../../../shared/mobile-composer'

/** Unsent drafts survive switching sessions and snapshot updates, per session. */
const drafts = new Map<string, string>()

export function MobileComposer({
  snapshot,
  send,
  abort,
  clearQueue
}: {
  snapshot: MobileConversationSnapshot
  send: (text: string) => Promise<void>
  abort: () => Promise<void>
  clearQueue: () => Promise<void>
}): React.JSX.Element {
  const key = snapshot.workerId
  const [draft, setDraftState] = useState(() => drafts.get(key) ?? '')
  const [sending, setSending] = useState(false)
  const [shownKey, setShownKey] = useState(key)
  const area = useRef<HTMLTextAreaElement>(null)
  if (shownKey !== key) {
    setShownKey(key)
    setDraftState(drafts.get(key) ?? '')
  }
  const setDraft = (value: string): void => {
    drafts.set(key, value)
    setDraftState(value)
  }
  useLayoutEffect(() => {
    const element = area.current
    if (!element) return
    element.style.height = '0px'
    element.style.height = `${Math.min(Math.max(element.scrollHeight, 44), 160)}px`
  }, [draft])
  const blocked = composeBlockChip(snapshot.composeBlockReason)
  const busy = snapshot.busy
  const queued = snapshot.queuedCount || 0
  const canSend = Boolean(draft.trim()) && !blocked && !sending
  const submit = (): void => {
    const text = draft.trim()
    if (!text || !canSend) return
    setSending(true)
    void send(text)
      .then(() => setDraft(''))
      .catch(() => {})
      .finally(() => setSending(false))
  }
  return (
    <form
      className="m-composer"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <p id="m-composer-keys" className="sr-only">
        Enter 发送，Shift+Enter 换行。运行中发送会加入队列。
      </p>
      <div className="m-composer-box">
        <textarea
          ref={area}
          rows={1}
          value={draft}
          enterKeyHint="send"
          autoComplete="off"
          placeholder={busy ? '补充要求，完成后接着做' : '提出后续要求'}
          aria-label="提出后续要求"
          aria-describedby="m-composer-keys"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (composerShouldSend(event.nativeEvent)) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className="m-composer-bar">
          <div className="m-chips">
            {busy ? <span className="m-chip is-run">运行中</span> : null}
            {queued ? <span className="m-chip is-run">队列 {queued}</span> : null}
            {queued ? (
              <button type="button" className="m-chip-button" onClick={() => void clearQueue()}>
                清空
              </button>
            ) : null}
            {blocked ? <span className="m-chip is-warn">{blocked}</span> : null}
            {snapshot.model ? (
              <span className="m-chip is-model" title={snapshot.model}>
                {snapshot.model}
              </span>
            ) : null}
          </div>
          {busy ? (
            <button type="button" className="m-stop" aria-label="停止" onClick={() => void abort()}>
              <Square size={12} fill="currentColor" aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="submit"
            className={`m-send${busy ? ' is-queue' : ''}`}
            aria-label={busy ? '加入队列' : '发送'}
            disabled={!canSend}
          >
            {busy ? '队列' : <ArrowUp size={18} aria-hidden="true" />}
          </button>
        </div>
      </div>
    </form>
  )
}
