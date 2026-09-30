import SubagentTool from '../components/SubagentTool'
import { conversationSubagents } from '../store/subagent-presentation'
import { ConversationActivity } from '../components/ConversationActivity'
import { memo, useMemo, useState } from 'react'
import {
  Brain,
  Check,
  ChevronRight,
  Copy,
  FileDiff,
  FileText,
  Globe2,
  Monitor,
  RotateCcw,
  Search,
  TerminalSquare,
  Wrench
} from 'lucide-react'
import type { ApprovalRequest, ConversationNode, ToolIntent } from '../../../shared/contracts'
import type { MobileConversationSnapshot } from '../../../shared/mobile-gateway'
import type {
  CheckpointPlan,
  CheckpointRestoreOutcome,
  CheckpointTurnState
} from '../../../shared/checkpoints'
import { workDigest, workPresentation, type WorkNode } from '../store/conversation-work-groups'
import {
  approvalSummary,
  currentToolApproval,
  toolMetaDisplay
} from '../store/conversation-presentation'
import { approvalPreview } from '../store/approval-presentation'
import type { TurnFileChange } from '../store/turn-changes'
import { ChangePath, DiffStat, ToolChangeView } from '../components/ToolChangeView'
import { MobileMarkdown } from './MobileMarkdown'
import { buildFlow, unplacedApprovals } from './flow'
import { copyText } from './copy'

type ToolNode = Extract<ConversationNode, { type: 'tool' }>
export type Respond = (
  approval: ApprovalRequest,
  allow: boolean,
  scope?: 'once' | 'turn'
) => Promise<void>

const TOOL_ICON: Record<ToolIntent, typeof TerminalSquare> = {
  terminal: TerminalSquare,
  read: FileText,
  diff: FileDiff,
  search: Search,
  web: Globe2,
  desktop: Monitor,
  generic: Wrench
}

const STATUS_LABEL: Record<ToolNode['status'], string> = {
  queued: '排队中',
  'awaiting-approval': '等待确认',
  'waiting-resource': '等待项目资源',
  incomplete: '未完成',
  running: '运行中',
  success: '完成',
  error: '失败',
  blocked: '已拒绝'
}

/** Snapshots arrive whole; rows only re-render when their own content changed. */
const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

function relative(title: string, projectPath: string): string {
  const root = projectPath.replace(/[\\/]+$/, '')
  return root ? title.split(`${root}/`).join('').split(`${root}\\`).join('') : title
}

function CopyButton({ text, label = '复制' }: { text: string; label?: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={`m-copy${copied ? ' is-copied' : ''}`}
      aria-label={label}
      onClick={() =>
        void copyText(text).then((ok) => {
          setCopied(ok)
          if (ok) setTimeout(() => setCopied(false), 1500)
        })
      }
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      <span>{copied ? '已复制' : label}</span>
    </button>
  )
}

export function ApprovalCard({
  approval,
  change,
  projectPath,
  respond
}: {
  approval: ApprovalRequest
  change?: ToolNode['change']
  projectPath: string
  respond: Respond
}): React.JSX.Element {
  const [pending, setPending] = useState<'allow' | 'deny' | null>(null)
  const preview = approvalPreview(approval)
  const answer = (allow: boolean, scope?: 'turn'): void => {
    setPending(allow ? 'allow' : 'deny')
    void respond(approval, allow, scope).finally(() => setPending(null))
  }
  return (
    <section className="m-approval" aria-label="等待批准">
      <header>
        <strong>等待批准</strong>
        <span>{approvalSummary(approval)}</span>
      </header>
      {change ? (
        <ToolChangeView change={change} projectPath={projectPath} />
      ) : (
        <div className="m-approval-detail">
          <small>{preview.label}</small>
          <pre>{preview.text}</pre>
          {preview.parameters ? (
            <details>
              <summary>全部参数</summary>
              <pre>{preview.parameters}</pre>
            </details>
          ) : null}
        </div>
      )}
      <div className="m-approval-actions">
        <button
          type="button"
          className="m-button is-danger"
          disabled={pending !== null}
          onClick={() => answer(false)}
        >
          {pending === 'deny' ? '正在拒绝…' : '拒绝'}
        </button>
        <button
          type="button"
          className="m-button is-primary"
          disabled={pending !== null}
          onClick={() => answer(true)}
        >
          {pending === 'allow' ? '正在允许…' : '允许'}
        </button>
      </div>
      {approval.grant ? (
        <button
          type="button"
          className="m-button m-approval-grant"
          disabled={pending !== null}
          onClick={() => answer(true, 'turn')}
        >
          本轮允许操作 {approval.grant.app}
        </button>
      ) : null}
    </section>
  )
}

const ToolRow = memo(
  function ToolRow({
    node,
    approval,
    projectPath,
    respond
  }: {
    node: ToolNode
    approval: ApprovalRequest | null
    projectPath: string
    respond: Respond
  }): React.JSX.Element {
    const [open, setOpen] = useState<boolean | null>(null)
    const Icon = TOOL_ICON[node.intent] ?? Wrench
    const change = node.change
    if (approval)
      return (
        <div className={`m-tool is-${node.status}`}>
          <ApprovalCard
            approval={approval}
            change={change}
            projectPath={projectPath}
            respond={respond}
          />
        </div>
      )
    const expanded = open ?? (node.status === 'error' || node.status === 'blocked')
    const hasDetail = Boolean(change || node.detail || node.output)
    return (
      <div className={`m-tool is-${node.status}${expanded ? ' is-open' : ''}`}>
        <button
          type="button"
          className="m-tool-head"
          aria-expanded={expanded}
          disabled={!hasDetail}
          onClick={() => setOpen(!expanded)}
        >
          <Icon size={14} aria-hidden="true" />
          {change ? (
            <span className="m-tool-title is-change">
              <span>{node.name === 'write' ? '写入' : '编辑'}</span>
              <ChangePath path={change.path} projectPath={projectPath} />
              <DiffStat additions={change.additions} deletions={change.deletions} />
            </span>
          ) : (
            <span className="m-tool-title">{relative(node.title, projectPath)}</span>
          )}
          {node.status !== 'success' ? (
            <span className="m-tool-status">{STATUS_LABEL[node.status]}</span>
          ) : null}
          {hasDetail ? <ChevronRight className="m-chevron" size={14} aria-hidden="true" /> : null}
        </button>
        {expanded ? (
          <div className="m-tool-detail">
            {change ? (
              <ToolChangeView change={change} projectPath={projectPath} header={false} />
            ) : null}
            {!change && node.detail ? <pre className="m-pre">{node.detail}</pre> : null}
            {node.output ? (
              <div className="m-tool-output">
                <span>
                  输出
                  {toolMetaDisplay(node).map((item) => (
                    <em key={item}>{item}</em>
                  ))}
                </span>
                <pre className="m-pre">{node.output}</pre>
              </div>
            ) : null}
            {change && node.detail ? (
              <details className="m-raw">
                <summary>原始参数</summary>
                <pre className="m-pre">{node.detail}</pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  },
  (a, b) =>
    a.projectPath === b.projectPath &&
    a.respond === b.respond &&
    same(a.node, b.node) &&
    same(a.approval, b.approval)
)

function ThinkRow({ node }: { node: Extract<WorkNode, { type: 'think' }> }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={`m-think${open ? ' is-open' : ''}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Brain size={14} aria-hidden="true" />
        <span>{node.streaming ? '正在思考…' : '思考了一会儿'}</span>
        <ChevronRight className="m-chevron" size={14} aria-hidden="true" />
      </button>
      {open ? <MobileMarkdown text={node.text} streaming={node.streaming} /> : null}
    </div>
  )
}

const WorkGroup = memo(
  function WorkGroup({
    nodes,
    running,
    approvals,
    projectPath,
    respond
  }: {
    nodes: WorkNode[]
    running: boolean
    approvals: ApprovalRequest[]
    projectPath: string
    respond: Respond
  }): React.JSX.Element {
    const [override, setOverride] = useState<boolean | null>(null)
    const { label, requiresAttention } = workPresentation(nodes, running)
    const awaiting = nodes.some(
      (node) => node.type === 'tool' && node.status === 'awaiting-approval'
    )
    const digest = running || awaiting ? null : workDigest(nodes)
    const expanded = awaiting || (override ?? requiresAttention)
    return (
      <section className={`m-work${running && !awaiting ? ' is-running' : ''}${expanded ? ' is-open' : ''}`}>
        <button
          type="button"
          className="m-work-head"
          aria-expanded={expanded}
          onClick={() => setOverride(!expanded)}
        >
          {running && !awaiting ? <span className="activity-orbit" aria-hidden="true" /> : <ChevronRight className="m-chevron" size={14} aria-hidden="true" />}
          <span className="m-work-label">{label}</span>
          {digest?.parts.length ? (
            <span className="m-work-digest">
              {digest.parts.map((part) => (
                <span key={part.label}>
                  {part.label} {part.count}
                </span>
              ))}
              {digest.failed ? <span className="is-failed">{digest.failed} 项失败</span> : null}
            </span>
          ) : null}
        </button>
        {expanded ? (
          <div className="m-work-body">
            {nodes.map((node) =>
              node.type === 'think' ? (
                <ThinkRow key={node.presentationIdentity ?? node.id} node={node} />
              ) : (
                <ToolRow
                  key={node.presentationIdentity ?? node.id}
                  node={node}
                  approval={currentToolApproval(node, approvals)}
                  projectPath={projectPath}
                  respond={respond}
                />
              )
            )}
          </div>
        ) : null}
      </section>
    )
  },
  (a, b) =>
    a.running === b.running &&
    a.projectPath === b.projectPath &&
    a.respond === b.respond &&
    same(a.nodes, b.nodes) &&
    same(a.approvals, b.approvals)
)

export type Undo = {
  state: CheckpointTurnState['state']
  blockedReason: string | null
  plan: () => Promise<CheckpointPlan | null>
  restore: (force: boolean) => Promise<CheckpointRestoreOutcome | null>
}

type UndoPhase =
  | { phase: 'idle' }
  | { phase: 'planning' }
  | { phase: 'confirm'; plan: CheckpointPlan }
  | { phase: 'restoring' }
  | { phase: 'message'; text: string }

const FILE_STATUS: Record<CheckpointPlan['files'][number]['status'], string> = {
  ready: '',
  conflict: '之后被改过',
  uncaptured: '无法还原'
}

function Receipt({
  files,
  projectPath,
  undo
}: {
  files: TurnFileChange[]
  projectPath: string
  undo?: Undo
}): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const [phase, setPhase] = useState<UndoPhase>({ phase: 'idle' })
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const restored = undo?.state === 'restored'
  const fail = (reason: unknown): void =>
    setPhase({ phase: 'message', text: reason instanceof Error ? reason.message : String(reason) })
  const plan = (): void => {
    if (!undo) return
    setPhase({ phase: 'planning' })
    undo
      .plan()
      .then(
        (result) =>
          setPhase(
            result
              ? { phase: 'confirm', plan: result }
              : { phase: 'message', text: '这一轮没有可撤销的文件改动。' }
          ),
        fail
      )
  }
  const restore = (force: boolean): void => {
    if (!undo) return
    setPhase({ phase: 'restoring' })
    undo.restore(force).then((outcome) => {
      if (!outcome || outcome.status === 'unavailable')
        setPhase({ phase: 'message', text: '改动记录已不可用。' })
      else if (outcome.status === 'conflict') setPhase({ phase: 'confirm', plan: outcome.plan })
      else if (!outcome.skipped.length && !outcome.failed.length) setPhase({ phase: 'idle' })
      else
        setPhase({
          phase: 'message',
          text: [
            `已撤销 ${outcome.restored} 个文件`,
            outcome.skipped.length ? `${outcome.skipped.length} 个无法还原` : '',
            outcome.failed.length ? `${outcome.failed.length} 个写入失败，可重试` : ''
          ]
            .filter(Boolean)
            .join('，')
        })
    }, fail)
  }
  const conflicts =
    phase.phase === 'confirm' && phase.plan.files.some((file) => file.status === 'conflict')
  return (
    <section className={`m-receipt${restored ? ' is-restored' : ''}`} aria-label="本轮改动">
      <header>
        <FileDiff size={14} aria-hidden="true" />
        <span>
          {restored ? '已撤销' : '已修改'} {files.length} 个文件
        </span>
        <DiffStat additions={additions} deletions={deletions} />
        {undo && !restored && phase.phase !== 'confirm' ? (
          <button
            type="button"
            className="m-undo"
            disabled={
              Boolean(undo.blockedReason) ||
              phase.phase === 'planning' ||
              phase.phase === 'restoring'
            }
            title={undo.blockedReason ?? '把这些文件还原到这一轮开始之前'}
            onClick={plan}
          >
            <RotateCcw size={13} aria-hidden="true" />
            {phase.phase === 'planning' || phase.phase === 'restoring' ? '处理中…' : '撤销'}
          </button>
        ) : null}
      </header>
      {phase.phase === 'confirm' ? (
        <div className="m-undo-confirm" role="alertdialog" aria-label="确认撤销">
          <p>
            将把 {phase.plan.files.length} 个文件还原到这一轮开始之前
            {phase.plan.laterTurns ? `，并一起撤销之后 ${phase.plan.laterTurns} 轮的改动` : ''}
            。对话记录不会改变。
          </p>
          <ul>
            {phase.plan.files.map((file) => (
              <li key={file.path}>
                <ChangePath path={file.path} projectPath={projectPath} />
                <span className={`is-${file.status}`}>
                  {file.action === 'delete' ? '删除' : '还原'}
                  {FILE_STATUS[file.status] ? ` · ${FILE_STATUS[file.status]}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <div className="m-approval-actions">
            <button type="button" className="m-button" onClick={() => setPhase({ phase: 'idle' })}>
              取消
            </button>
            <button
              type="button"
              className={`m-button ${conflicts ? 'is-danger' : 'is-primary'}`}
              onClick={() => restore(conflicts)}
            >
              {conflicts ? '仍然覆盖' : '撤销改动'}
            </button>
          </div>
        </div>
      ) : null}
      {phase.phase === 'message' ? (
        <p className="m-undo-message" role="status">
          {phase.text}
        </p>
      ) : null}
      {files.map((file) => (
        <div key={file.path} className={`m-receipt-file${open === file.path ? ' is-open' : ''}`}>
          <button
            type="button"
            aria-expanded={open === file.path}
            onClick={() => setOpen(open === file.path ? null : file.path)}
          >
            <ChangePath path={file.path} projectPath={projectPath} />
            <DiffStat additions={file.additions} deletions={file.deletions} />
            <ChevronRight className="m-chevron" size={14} aria-hidden="true" />
          </button>
          {open === file.path
            ? file.changes.map((change, index) => (
                <ToolChangeView
                  key={index}
                  change={change}
                  projectPath={projectPath}
                  header={false}
                />
              ))
            : null}
        </div>
      ))}
    </section>
  )
}

const NodeView = memo(
  function NodeView({
    node,
    latest
  }: {
    node: ConversationNode
    latest: boolean
  }): React.JSX.Element | null {
    switch (node.type) {
      case 'user':
        return (
          <div className="m-user">
            <p className="m-bubble">{node.text}</p>
            <div className="m-actions">
              {node.imageCount ? <span>{node.imageCount} 张图片</span> : null}
              <CopyButton text={node.text} />
            </div>
          </div>
        )
      case 'assistant':
        return (
          <article className={`m-assistant${node.streaming ? ' is-streaming' : ''}`}>
            <MobileMarkdown text={node.markdown} streaming={node.streaming} />
            {!node.streaming && node.markdown ? (
              <div className={`m-actions${latest ? ' is-latest' : ''}`}>
                <CopyButton text={node.markdown} />
              </div>
            ) : null}
          </article>
        )
      case 'error':
        return (
          <p className="m-line is-error" role="alert">
            {node.message}
          </p>
        )
      case 'stopped':
        return <p className="m-line is-stopped">{node.message}</p>
      case 'model':
        return (
          <p className="m-line">
            {node.initial ? '模型' : '模型切换'} · {node.name || node.modelId}
          </p>
        )
      case 'compaction':
        return <p className="m-line">上下文已压缩</p>
      default:
        return null
    }
  },
  (a, b) => a.latest === b.latest && same(a.node, b.node)
)

export function MobileConversation({
  snapshot,
  respond,
  undo
}: {
  snapshot: MobileConversationSnapshot
  respond: Respond
  undo?: (entryId: string) => Undo | undefined
}): React.JSX.Element {
  const childrenById = useMemo(() => conversationSubagents(snapshot.nodes, []), [snapshot.nodes])
  const flow = useMemo(
    () => buildFlow(snapshot.nodes, snapshot.busy),
    [snapshot.nodes, snapshot.busy]
  )
  const orphans = useMemo(
    () => unplacedApprovals(snapshot.nodes, snapshot.approvals),
    [snapshot.nodes, snapshot.approvals]
  )
  return (
    <div className="m-flow">
      {flow.map((item) =>
        item.kind === 'work' ? (
          <WorkGroup
            key={item.key}
            nodes={item.nodes}
            running={item.running}
            approvals={snapshot.approvals}
            projectPath={snapshot.cwd}
            respond={respond}
          />
        ) : item.kind === 'receipt' ? (
          <Receipt
            key={item.key}
            files={item.files}
            projectPath={snapshot.cwd}
            undo={item.entryId ? undo?.(item.entryId) : undefined}
          />
        ) : item.node.type === 'tool' && item.node.subagent ? (
          <SubagentTool key={item.key} node={item.node} childrenById={childrenById} renderOutput={(text, streaming) => <MobileMarkdown text={text} streaming={streaming} />} />
        ) : (
          <NodeView key={item.key} node={item.node} latest={item.latest} />
        )
      )}
      <ConversationActivity nodes={snapshot.nodes} busy={snapshot.busy} approvals={snapshot.approvals.length} />
      {orphans.map((approval) => (
        <ApprovalCard
          key={`${approval.generation}:${approval.id}`}
          approval={approval}
          projectPath={snapshot.cwd}
          respond={respond}
        />
      ))}
    </div>
  )
}
