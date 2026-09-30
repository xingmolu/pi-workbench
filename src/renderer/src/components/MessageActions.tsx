import { useId, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react'
import { Check, Copy, Pencil, ThumbsDown, ThumbsUp } from 'lucide-react'
import { create } from 'zustand'
import type { AgentSnapshot, ConversationNode } from '../../../shared/contracts'
import { useMarkdownCopy } from './markdown-copy-action'
import { usePiStore } from '../store/pi-store'
import { prepareSessionEdit, useSessionEdit } from '../store/session-edit'
import SessionFork from './SessionFork'

export function ActionIcon({
  label,
  hint = label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  hint?: string
  children: ReactNode
  ref?: Ref<HTMLButtonElement>
}): React.JSX.Element {
  const id = useId()
  return (
    <span className="message-action-wrap">
      <button
        {...props}
        type="button"
        className={`message-action-icon ${props.className ?? ''}`}
        aria-label={label}
        aria-describedby={id}
      >
        {children}
      </button>
      <span id={id} className="message-action-tooltip" role="tooltip">
        {hint}
      </span>
    </span>
  )
}

const useFeedbackPending = create<{ states: Record<string, 'pending' | 'uncertain'> }>()(() => ({
  states: {}
}))
export default function MessageActions({
  node,
  snapshot
}: {
  node: Extract<ConversationNode, { type: 'user' | 'assistant' }>
  snapshot: AgentSnapshot
}): React.JSX.Element {
  const text = node.type === 'user' ? node.text : node.markdown
  const scope = JSON.stringify([snapshot.sessionId, snapshot.generation, node.canonicalEntryId])
  const { status, copy } = useMarkdownCopy(scope + node.id + ':' + text)
  const edit = useSessionEdit()
  const feedbackState = useFeedbackPending((s) => s.states[scope])
  const pending = feedbackState === 'pending'
  const failure =
    feedbackState === 'uncertain'
      ? '反馈结果无法确认，请重新打开会话读取记录；不要直接重试。'
      : null
  const reason = !snapshot.ready ? '请先连接引擎' : snapshot.fork?.reason
  const feedbackReason =
    reason ?? (!node.canonicalEntryId ? '回复尚未完成，暂时不能记录反馈' : null)
  const feedback = async (value: 'up' | 'down') => {
    if (
      feedbackReason ||
      useFeedbackPending.getState().states[scope] ||
      node.type !== 'assistant' ||
      !node.canonicalEntryId ||
      !snapshot.sessionId
    )
      return
    useFeedbackPending.setState((s) => ({ states: { ...s.states, [scope]: 'pending' } }))
    try {
      const result = await window.pi.send({
        type: 'message:feedback',
        sessionId: snapshot.sessionId,
        generation: snapshot.generation,
        entryId: node.canonicalEntryId,
        value: node.feedback === value ? null : value
      })
      if (result.sessionId !== snapshot.sessionId || result.generation !== snapshot.generation)
        throw new Error('反馈结果无法确认')
    } catch {
      const current = usePiStore.getState().snapshot
      if (current.sessionId === snapshot.sessionId && current.generation === snapshot.generation)
        useFeedbackPending.setState((s) => ({ states: { ...s.states, [scope]: 'uncertain' } }))
    } finally {
      if (useFeedbackPending.getState().states[scope] === 'pending')
        useFeedbackPending.setState((s) => {
          const states = { ...s.states }
          delete states[scope]
          return { states }
        })
    }
  }
  return (
    <>
      <div className="message-actions" aria-label={node.type === 'user' ? '问题操作' : '回复操作'}>
        <ActionIcon
          label={node.type === 'user' ? '复制问题' : '复制回复'}
          hint={
            status === 'success'
              ? '已复制'
              : status === 'pending'
                ? '正在复制…'
                : !text
                  ? '此消息只有图片，没有可复制文本'
                  : node.type === 'user' && node.imageCount
                    ? '复制问题文本（不含图片）'
                    : node.type === 'assistant' && node.streaming
                      ? '复制当前内容'
                      : node.type === 'user'
                        ? '复制问题'
                        : '复制回复'
          }
          disabled={status === 'pending' || !text}
          onClick={() => void copy(text)}
        >
          {status === 'success' ? <Check size={16} /> : <Copy size={16} />}
        </ActionIcon>
        {node.type === 'user' &&
        node.canonicalEntryId &&
        node.canonicalEntryId === snapshot.edit?.entryId &&
        edit.phase === 'closed' ? (
          <ActionIcon
            label="编辑问题"
            hint={snapshot.edit?.reason ?? '编辑最近的问题'}
            aria-disabled={!snapshot.ready || Boolean(snapshot.edit?.reason)}
            onClick={() => {
              if (snapshot.ready && !snapshot.edit?.reason) void prepareSessionEdit(snapshot)
            }}
          >
            <Pencil size={16} />
          </ActionIcon>
        ) : null}
        {node.type === 'assistant' ? (
          <>
            <SessionFork key={JSON.stringify([scope, snapshot.desktopScope ?? null])} snapshot={snapshot} entryId={node.canonicalEntryId} messageAction />
            {(!snapshot.runtime || snapshot.runtime.features.includes('message-feedback')) && (['up', 'down'] as const).map((value) => (
              <ActionIcon
                key={value}
                label={value === 'up' ? '赞' : '踩'}
                hint={failure ?? feedbackReason ?? '仅本地记录，不发送给模型服务商'}
                aria-pressed={node.feedback === value}
                aria-disabled={Boolean(feedbackReason || failure || pending)}
                onClick={() => void feedback(value)}
              >
                {value === 'up' ? <ThumbsUp size={16} /> : <ThumbsDown size={16} />}
              </ActionIcon>
            ))}
          </>
        ) : null}
      </div>
      <span
        className="message-action-result"
        role="status"
        aria-label={node.type === 'user' ? '问题复制结果' : '回复复制结果'}
      >
        {status === 'error'
          ? '复制失败，请重试或选中文本手动复制。'
          : status === 'success'
            ? node.type === 'user'
              ? '问题文本已复制'
              : '回复已复制'
            : ''}
      </span>
      {failure ? (
        <span className="message-action-result" role="alert">
          {failure}
        </span>
      ) : null}
    </>
  )
}
