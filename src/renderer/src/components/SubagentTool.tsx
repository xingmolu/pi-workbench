import { useState, type ReactNode } from 'react'
import { Bot, ChevronRight, CircleAlert, MoreHorizontal, Pause } from 'lucide-react'
import type { ConversationNode } from '../../../shared/contracts'
import type { SubagentSummary } from '../../../shared/subagent'
import { SUBAGENT_STATE_LABEL } from '../store/subagent-presentation'
import { Markdown } from './Markdown'
import '../assets/subagent.css'

type RenderOutput = (text: string, streaming: boolean, id: string) => ReactNode
const LABEL = {
  spawn: '子 Agent',
  observe: '检查子 Agent 进度',
  collect: '汇总子 Agent 结果',
  send: '补充任务',
  cancel: '停止子 Agent',
  release: '结束协作'
}

/** Child activity stays a single summary line; the transcript lives in a side pane. */
export default function SubagentTool({
  node,
  childrenById,
  onInspect,
  renderOutput
}: {
  node: Extract<ConversationNode, { type: 'tool' }>
  childrenById: ReadonlyMap<string, SubagentSummary>
  onInspect?: (child: SubagentSummary) => void
  renderOutput?: RenderOutput
}): React.JSX.Element {
  const [raw, setRaw] = useState(false)
  const [selected, setSelected] = useState<SubagentSummary | null>(null)
  const operation = node.subagent!
  const children = operation.children.map((child) => childrenById.get(child.id) ?? child)
  const inspect = (child: SubagentSummary): void => {
    if (onInspect) onInspect(child)
    else setSelected((current) => (current?.id === child.id ? null : child))
  }
  return (
    <section className="subagent-tool" aria-label="子 Agent 协作">
      {operation.operation === 'spawn' ? (
        <div className="subagent-list">
          {children.map((child, index) => {
            const active = child.state === 'running' || child.state === 'queued'
            return (
              <button
                type="button"
                key={`${node.toolCallId}:${index}`}
                className={`subagent-summary is-${child.state}`}
                data-subagent-id={child.id}
                aria-label={`查看子 Agent：${child.title}`}
                onClick={() => inspect(child)}
                title={child.title}
              >
                <Bot className="subagent-summary-icon" size={15} aria-hidden="true" />
                <span className={`subagent-kind${active ? ' is-active' : ''}`}>子 Agent</span>
                <span className="subagent-summary-content" key={child.activity ?? child.title}>
                  {active && child.activity ? child.activity : child.title}
                </span>
                {child.state === 'awaiting-approval' ? (
                  <span className="subagent-state">
                    <Pause size={12} />
                    等待确认
                  </span>
                ) : child.state === 'error' || child.state === 'unavailable' ? (
                  <span className="subagent-state" title={child.output}>
                    <CircleAlert size={12} />
                    {SUBAGENT_STATE_LABEL[child.state]}
                  </span>
                ) : child.state === 'stopped' ? (
                  <span className="subagent-state">已停止</span>
                ) : (
                  <span className="sr-only">{SUBAGENT_STATE_LABEL[child.state]}</span>
                )}
                <ChevronRight className="subagent-summary-arrow" size={14} aria-hidden="true" />
              </button>
            )
          })}
        </div>
      ) : (
        <div className={`subagent-operation${node.status === 'running' ? ' is-active' : ''}`}>
          <Bot size={14} aria-hidden="true" />
          <span>{LABEL[operation.operation]}</span>
          {children.length ? <span>· {children.length} 个</span> : null}
        </div>
      )}
      {node.status === 'error' && operation.operation !== 'spawn' ? (
        <p className="subagent-action-error">{node.output || '协作操作失败'}</p>
      ) : null}
      <button
        type="button"
        className="subagent-raw-toggle"
        aria-label="查看协作调用详情"
        aria-expanded={raw}
        onClick={() => setRaw(!raw)}
      >
        <MoreHorizontal size={14} />
      </button>
      {raw ? (
        <div className="subagent-raw">
          <pre>{node.detail}</pre>
          <pre>{node.output}</pre>
        </div>
      ) : null}
      {!onInspect && selected ? (
        <div className="subagent-mobile-detail">
          <h4>{selected.title}</h4>
          <span>{SUBAGENT_STATE_LABEL[selected.state]}</span>
          {selected.prompt ? <p>{selected.prompt}</p> : null}
          {selected.output ? (
            (renderOutput?.(selected.output, selected.state === 'running', selected.id) ?? (
              <Markdown>{selected.output}</Markdown>
            ))
          ) : (
            <p>尚无可展示的输出。</p>
          )}
        </div>
      ) : null}
    </section>
  )
}
