import { useEffect, useMemo, useState } from 'react'
import { Bot, ChevronRight, CircleAlert, LoaderCircle, Pause, X } from 'lucide-react'
import { conversationSubagents, SUBAGENT_STATE_LABEL } from '../store/subagent-presentation'
import { usePiStore } from '../store/pi-store'
import type { SubagentSummary } from '../../../shared/subagent'

export default function SubagentDirectory({
  onInspect,
  onClose
}: {
  onInspect: (child: SubagentSummary) => void
  onClose: () => void
}): React.JSX.Element {
  const nodes = usePiStore((state) => state.snapshot.nodes)
  const live = usePiStore((state) => state.liveSessions)
  const children = useMemo(() => [...conversationSubagents(nodes, live).values()], [nodes, live])
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.querySelector('[role="dialog"], [role="alertdialog"]')
      ) {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  const active = children.filter((child) =>
    ['queued', 'running', 'awaiting-approval'].includes(child.state)
  )
  const completed = children.filter((child) => !active.includes(child)).reverse()
  return (
    <aside className="subagent-inspector subagent-directory" aria-label="子 Agent 列表">
      <header className="subagent-pane-header">
        <Bot size={16} />
        <span>子 Agent</span>
        <button type="button" aria-label="关闭子 Agent 列表" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="subagent-directory-scroll">
        {group('进行中', active)}
        {group('已结束', completed)}
      </div>
    </aside>
  )

  function group(label: string, items: SubagentSummary[]) {
    return (
      <section className="subagent-directory-group">
        <h3>
          {label}
          <span>· {items.length}</span>
        </h3>
        {!items.length ? (
          <p>{label === '进行中' ? '没有正在运行的子 Agent' : '完成的任务会保留在这里'}</p>
        ) : (
          items.map((child) => {
            const elapsed = child.startedAt
              ? Math.max(0, Math.floor((now - child.startedAt) / 60_000))
              : null
            const Icon =
              child.state === 'running' || child.state === 'queued'
                ? LoaderCircle
                : child.state === 'awaiting-approval'
                  ? Pause
                  : child.state === 'error' || child.state === 'unavailable'
                    ? CircleAlert
                    : Bot
            return (
              <button
                type="button"
                key={child.id}
                className={`subagent-directory-row is-${child.state}`}
                data-subagent-id={child.id}
                aria-label={`查看子 Agent：${child.title}`}
                onClick={() => onInspect(child)}
              >
                <Icon size={17} className={Icon === LoaderCircle ? 'spin' : undefined} />
                <span className="subagent-directory-content">
                  <strong>{child.title}</strong>
                  <small>{child.activity || SUBAGENT_STATE_LABEL[child.state]}</small>
                </span>
                {elapsed !== null ? (
                  <time>
                    {elapsed < 1
                      ? '刚刚'
                      : elapsed < 60
                        ? `${elapsed} 分钟`
                        : `${Math.floor(elapsed / 60)} 小时`}
                  </time>
                ) : null}
                <ChevronRight size={13} className="subagent-directory-arrow" />
              </button>
            )
          })
        )}
      </section>
    )
  }
}
