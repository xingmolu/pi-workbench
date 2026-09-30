import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  FileText,
  Search,
  Square,
  TerminalSquare,
  X
} from 'lucide-react'
import type { AgentSnapshot, ConversationNode } from '../../../shared/contracts'
import type { DesktopCommandOrigin } from '../../../shared/session-runtime'
import type { SubagentSummary } from '../../../shared/subagent'
import { usePiStore } from '../store/pi-store'
import { conversationSubagents, SUBAGENT_STATE_LABEL } from '../store/subagent-presentation'
import { formatTokens } from '../store/conversation-presentation'
import { Markdown } from './Markdown'
import { ToolChangeView } from './ToolChangeView'
import '../assets/subagent.css'

function TranscriptNode({
  node,
  projectPath
}: {
  node: ConversationNode
  projectPath?: string
}): React.JSX.Element | null {
  if (node.type === 'assistant')
    return (
      <article className="subagent-reply">
        <Markdown identity={node.id} streaming={node.streaming}>
          {node.markdown}
        </Markdown>
      </article>
    )
  if (node.type === 'user')
    return (
      <div className="subagent-task-prompt">
        <span>任务</span>
        <p>{node.text}</p>
      </div>
    )
  if (node.type === 'think')
    return (
      <details className="subagent-thinking">
        <summary>
          <span>{node.streaming ? '思考中' : '思考过程'}</span>
          <ChevronDown size={12} />
        </summary>
        <Markdown streaming={node.streaming}>{node.text}</Markdown>
      </details>
    )
  if (node.type === 'tool') {
    const Icon =
      node.intent === 'terminal' ? TerminalSquare : node.intent === 'search' ? Search : FileText
    return (
      <details
        className={`subagent-transcript-tool is-${node.status}`}
        open={node.status === 'error' || node.status === 'awaiting-approval'}
      >
        <summary>
          <Icon size={14} />
          <span className={node.status === 'running' ? 'is-active' : ''}>{node.title}</span>
          <ChevronDown size={12} />
        </summary>
        {node.change ? (
          <ToolChangeView change={node.change} projectPath={projectPath} header={false} />
        ) : null}
        {node.output ? (
          <pre>{node.output}</pre>
        ) : node.detail ? (
          <pre>{node.detail}</pre>
        ) : (
          <p>等待输出…</p>
        )}
      </details>
    )
  }
  if (node.type === 'error' || node.type === 'stopped')
    return <p className={`subagent-transcript-notice is-${node.type}`}>{node.message}</p>
  return null
}

export default function SubagentInspector({
  child: initial,
  owner,
  parentNodes,
  onClose,
  onOpen
}: {
  child: SubagentSummary
  owner: DesktopCommandOrigin
  parentNodes: ConversationNode[]
  onClose: () => void
  onOpen: (path: string) => void
}): React.JSX.Element {
  const native = usePiStore((state) => state.snapshot.runtime?.subagents === 'native')
  const live = usePiStore((state) => state.liveSessions)
  const current = useMemo(
    () => conversationSubagents(parentNodes, live).get(initial.id) ?? initial,
    [parentNodes, live, initial]
  )
  const resident = live.find(
    (session) =>
      session.workerId === current.workerId &&
      session.sessionId === current.sessionId &&
      session.generation === current.generation
  )
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const version = useRef(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  useEffect(() => {
    version.current++
    setSnapshot(null)
    setMessage(null)
    following.current = true
    return () => {
      version.current++
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = null
    }
  }, [initial.id, owner])
  useEffect(() => {
    if ((!resident && !native) || refreshTimer.current) return
    const request = version.current
    refreshTimer.current = setTimeout(
      () => {
        refreshTimer.current = null
        void window.pi
          .inspectSubagent(initial.id, owner)
          .then((next) => {
            if (version.current !== request) return
            setSnapshot(next)
            setMessage(null)
          })
          .catch(() => {
            if (version.current === request) setMessage('无法连接子会话，显示已保存的结果。')
          })
      },
      snapshot ? 180 : 0
    )
    // Coalesce runtime events without delaying a continuously streaming child indefinitely.
  }, [
    initial.id,
    resident?.sessionTask?.progress?.revision,
    resident?.workerId,
    current.revision,
    native,
    owner
  ])
  useEffect(() => {
    if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [snapshot?.revision])
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]')
      ) {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onClose])
  const active = ['queued', 'running', 'awaiting-approval'].includes(current.state)
  return (
    <aside className="subagent-inspector" aria-label="子 Agent 详情">
      <header className="subagent-pane-header">
        <Bot size={16} />
        <span>子 Agent</span>
        <span className="subagent-pane-readonly">只读</span>
        <button type="button" aria-label="关闭子 Agent 详情" title="关闭（Esc）" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="subagent-pane-heading">
        <div className="subagent-pane-title">{current.title}</div>
        <div className="subagent-pane-meta">
          <span
            className={`subagent-pane-status is-${current.state}${current.state === 'running' ? ' is-active' : ''}`}
          >
            {SUBAGENT_STATE_LABEL[current.state]}
          </span>
          {current.model ? <span>{current.model}</span> : null}
          {current.tokens ? <span>{formatTokens(current.tokens)} tokens</span> : null}
          <div className="subagent-pane-actions">
            {resident?.sessionPath ? (
              <button
                type="button"
                aria-label="打开完整子会话"
                title="打开完整子会话"
                onClick={() => onOpen(resident.sessionPath!)}
              >
                <ExternalLink size={14} />
              </button>
            ) : null}
            {(resident || native) && active ? (
              <button
                type="button"
                aria-label="停止此子 Agent"
                title="停止此子 Agent"
                disabled={pending}
                onClick={() => {
                  if (!owner.sessionId) return
                  setPending(true)
                  void window.pi
                    .send(
                      {
                        type: 'session-task:cancel',
                        taskId: current.id,
                        sessionId: owner.sessionId,
                        generation: owner.generation
                      },
                      owner
                    )
                    .catch((error) =>
                      setMessage(error instanceof Error ? error.message : String(error))
                    )
                    .finally(() => setPending(false))
                }}
              >
                <Square size={13} />
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {current.state === 'awaiting-approval' && resident?.sessionPath ? (
        <button
          type="button"
          className="subagent-approval-banner"
          onClick={() => onOpen(resident.sessionPath!)}
        >
          <CircleAlert size={14} />
          <span>需要确认操作</span>
          <span>
            前往子会话 <ExternalLink size={12} />
          </span>
        </button>
      ) : null}
      <div
        className="subagent-pane-scroll"
        ref={scroll}
        onScroll={() => {
          const element = scroll.current
          if (element)
            following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60
        }}
      >
        {message ? (
          <p className="subagent-pane-message" role="status">
            {message}
          </p>
        ) : null}
        {snapshot ? (
          <div className="subagent-transcript">
            {snapshot.nodes.map((node) => (
              <TranscriptNode
                key={node.presentationIdentity ?? node.id}
                node={node}
                projectPath={snapshot.project?.path}
              />
            ))}
          </div>
        ) : (
          <>
            <div className="subagent-task-prompt">
              <span>任务</span>
              <p>{current.prompt ?? current.title}</p>
            </div>
            {current.output ? (
              <article className="subagent-reply">
                <Markdown streaming={active}>{current.output}</Markdown>
              </article>
            ) : (
              <p className="subagent-pane-message">
                {resident ? '正在连接子会话…' : '没有可展示的输出。'}
              </p>
            )}
          </>
        )}
      </div>
      <footer className="subagent-pane-footer">
        <span>独立上下文</span>
        <span>查看详情不会中断父 Agent</span>
      </footer>
    </aside>
  )
}
