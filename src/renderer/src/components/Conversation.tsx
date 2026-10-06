import SubagentTool from './SubagentTool'
import type { SubagentSummary } from '../../../shared/subagent'
import { conversationSubagents } from '../store/subagent-presentation'
import { ConversationActivity } from './ConversationActivity'
import { Fragment, memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import * as Collapsible from '@radix-ui/react-collapsible'
import * as Popover from '@radix-ui/react-popover'
import { Markdown } from './Markdown'
import { useDesktopSettings } from '../store/desktop-settings'
import { shouldSendOnKey } from '../../../shared/desktop-settings'
import MessageActions from './MessageActions'
import SkillPicker, { type SkillPickerHandle, type SkillMenuState } from './SkillPicker'
import { insertSkillDraft, skillDraftIdentity, useSkillInsertion } from '../store/skill-draft'
import WorkSummary from './WorkSummary'
import ApprovalCard, { type ApprovalHandler } from './ApprovalCard'
import { useOffscreenApproval } from '../store/use-approval-visibility'
import {
  groupConversationWork,
  type ConversationWorkGroup
} from '../store/conversation-work-groups'
import { summarizeTurnChanges, type TurnFileChange } from '../store/turn-changes'
import { ChangePath, DiffStat, ToolChangeView } from './ToolChangeView'
import TurnChanges, { type TurnCheckpoint } from './TurnChanges'
import { parseTextContext } from '../../../shared/text-attachments'
import {
  useTextAttachments,
  stageTextFile,
  removeTextFile,
  sendTextFiles
} from '../store/text-attachments'
import {
  ArrowUp,
  ArrowDown,
  Bug,
  Compass,
  FlaskConical,
  ArrowLeft,
  ArrowRightLeft,
  Archive,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileDiff,
  FileText,
  FolderOpen,
  Globe2,
  LockKeyhole,
  ListPlus,
  KeyRound,
  MessageSquare,
  Sparkles,
  Monitor,
  Plus,
  Search,
  Square,
  TerminalSquare,
  Wrench
} from 'lucide-react'
import type {
  AgentSnapshot,
  ApprovalRequest,
  ConversationNode,
  PermissionMode,
  ToolIntent,
  UsageMetrics
} from '../../../shared/contracts'
import { activeSessionHeader } from '../../../shared/session-presentation'
import SessionActions from './SessionActions'
import SessionFork from './SessionFork'
import UserMessageEdit from './UserMessageEdit'
import { useSessionEdit } from '../store/session-edit'
import { usePiStore } from '../store/pi-store'
import { useComposerPrefill } from '../store/composer-prefill'
import QuestionNavigation from './QuestionNavigation'
import { relativeTime } from './relative-time'
import { useRevealOnOpen } from './use-reveal-on-open'
import { formatElapsed, useRunElapsed } from '../store/run-clock'
import ModelPicker from './ModelPicker'
import PermissionControl from './PermissionControl'
import {
  composerStatsDisplay,
  approvalSummary,
  currentToolApproval,
  contextDisplay,
  formatTokens,
  runtimeMetricsDisplay,
  toolMetaDisplay
} from '../store/conversation-presentation'
import { t } from '../../../shared/i18n'

type ConversationProps = {
  snapshot: AgentSnapshot
  onInspectSubagent?: (child: SubagentSummary) => void
  approvals: ApprovalRequest[]
  loading: boolean
  error?: string | null
  onChooseProject: () => void
  recentProject?: { path: string; name: string; sessionPath?: string; sessionTitle?: string } | null
  onContinueProject?: (path: string, sessionPath?: string) => void
  projectNavigationPending?: boolean
  onOpenSession: (path: string) => void
  onSend: (text: string, identity: { sessionId: string; generation: number }) => Promise<boolean>
  onReconnect: () => void
  reconnecting: boolean
  onAbort: () => void
  onClearQueue: () => void
  onPermissionChange: (permission: PermissionMode) => void
  onChooseModel: (providerId: string, modelId: string) => void
  onLogin: () => void
  onOpenSettings: () => void
  /** The home page's "connect a model" choices. */
  onConnect?: (choice: ConnectChoice) => void
  onApproval: ApprovalHandler
}

const TOOL_ICON: Record<ToolIntent, typeof TerminalSquare> = {
  terminal: TerminalSquare,
  read: FileText,
  diff: FileDiff,
  search: Search,
  web: Globe2,
  desktop: Monitor,
  generic: Wrench
}

/** Tool titles embed absolute paths; inside the open project the prefix is noise. */
function projectRelative(title: string, projectPath?: string): string {
  if (!projectPath) return title
  const root = projectPath.replace(/[\\/]+$/, '')
  return title.split(`${root}/`).join('').split(`${root}\\`).join('')
}

const STARTERS = [
  {
    icon: Compass,
    label: t('梳理项目结构'),
    prompt: t('梳理这个项目的结构、关键模块和它们之间的关系。')
  },
  { icon: Bug, label: t('排查一个问题'), prompt: t('帮我排查这个问题：') },
  {
    icon: FlaskConical,
    label: t('补充测试'),
    prompt: t('为最近修改的代码补充测试，并运行确认通过。')
  }
] as const

export type ConnectChoice = 'chatgpt' | 'claude' | 'api'

const CONNECT_CHOICES: Record<
  ConnectChoice,
  { icon: typeof Compass; title: string; detail: (runtimeId?: string) => string }
> = {
  chatgpt: {
    icon: MessageSquare,
    title: t('ChatGPT 账号'),
    detail: () => t('用 Plus / Pro 订阅在浏览器里登录，Pi 和 Codex 都能用')
  },
  claude: {
    icon: Sparkles,
    title: t('Claude 账号'),
    detail: (runtimeId) =>
      runtimeId === 'claude'
        ? t('用 Pro / Max 订阅在浏览器里登录')
        : t('Pro / Max 订阅在 Claude Code 引擎里使用，首次需要下载引擎')
  },
  api: {
    icon: KeyRound,
    title: 'API Key',
    detail: () => t('OpenRouter、DeepSeek、Kimi、Anthropic 等服务，或公司网关')
  }
}

/** Shown on the home page until the engine has an account it can send with. */
function ConnectChoices({
  runtimeId,
  onConnect
}: {
  runtimeId?: string
  onConnect?: (choice: ConnectChoice) => void
}): React.JSX.Element {
  const choices: ConnectChoice[] =
    runtimeId === 'claude'
      ? ['claude', 'api']
      : runtimeId === 'codex'
        ? ['chatgpt']
        : ['chatgpt', 'api', 'claude']
  return (
    <section className="home-connect" aria-label={t('连接模型')}>
      <p className="home-connect-title">{t('先连接一个模型账号，就可以开始了')}</p>
      <div className="home-connect-options">
        {choices.map((choice) => {
          const { icon: Icon, title, detail } = CONNECT_CHOICES[choice]
          return (
            <button
              key={choice}
              type="button"
              className="home-connect-option"
              onClick={() => onConnect?.(choice)}
            >
              <Icon size={16} aria-hidden="true" />
              <strong>{title}</strong>
              <span>{detail(runtimeId)}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

const STATUS_LABEL = {
  queued: t('排队中'),
  'awaiting-approval': t('等待确认'),
  'waiting-resource': t('等待项目资源'),
  incomplete: t('未完成'),
  running: t('运行中'),
  success: t('完成'),
  error: t('失败'),
  blocked: t('已拒绝')
} as const

const ThinkNode = memo(function ThinkNode({
  node
}: {
  node: Extract<ConversationNode, { type: 'think' }>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible.Root className="think-node" open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger className="think-trigger">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Brain size={14} />
        <span>{node.streaming ? t('正在思考…') : t('思考了一会儿')}</span>
      </Collapsible.Trigger>
      <Collapsible.Content className="think-content">
        <Markdown>{node.text}</Markdown>
      </Collapsible.Content>
    </Collapsible.Root>
  )
})

const ToolNode = memo(function ToolNode({
  node,
  activeApproval,
  projectPath,
  onApproval
}: {
  node: Extract<ConversationNode, { type: 'tool' }>
  activeApproval: ApprovalRequest | null
  projectPath?: string
  onApproval: ApprovalHandler
}): React.JSX.Element {
  const [open, setOpen] = useState<boolean | null>(null)
  const detail = useRevealOnOpen<HTMLDivElement>(open === true)
  const Icon = TOOL_ICON[node.intent]
  const meta = toolMetaDisplay(node)
  const change = node.change
  return (
    <Collapsible.Root
      className={`tool-node is-${node.status}`}
      open={
        Boolean(activeApproval) || (open ?? (node.status === 'error' || node.status === 'blocked'))
      }
      onOpenChange={setOpen}
    >
      {!activeApproval && (
        <Collapsible.Trigger className="tool-trigger">
          <Icon size={15} />
          {change ? (
            <span className="tool-title is-change">
              <span className="tool-verb">{node.name === 'write' ? t('写入') : t('编辑')}</span>
              <ChangePath path={change.path} projectPath={projectPath} />
              <DiffStat additions={change.additions} deletions={change.deletions} />
            </span>
          ) : (
            <span className="tool-title">{projectRelative(node.title, projectPath)}</span>
          )}
          <span className={node.status === 'success' ? 'sr-only' : 'tool-status'}>
            {STATUS_LABEL[node.status]}
          </span>
          {meta.map((item) => (
            <span className="tool-meta" key={item}>
              {item}
            </span>
          ))}
          <ChevronRight className="tool-chevron" size={14} />
        </Collapsible.Trigger>
      )}
      <Collapsible.Content className="tool-detail" ref={detail}>
        {activeApproval ? (
          <ApprovalCard
            key={`${activeApproval.generation}:${activeApproval.id}`}
            request={activeApproval}
            change={change}
            projectPath={projectPath}
            onApproval={(id, allow, scope) => {
              setOpen(true)
              return onApproval(id, allow, scope)
            }}
          />
        ) : change ? (
          <>
            <ToolChangeView change={change} projectPath={projectPath} header={false} />
            {node.output ? (
              <div className="tool-output">
                <span>{t('输出')}</span>
                <pre>{node.output}</pre>
              </div>
            ) : null}
            {node.detail ? (
              <details className="tool-raw">
                <summary>{t('原始参数')}</summary>
                <pre>{node.detail}</pre>
              </details>
            ) : null}
          </>
        ) : (
          <>
            {node.detail ? <pre>{node.detail}</pre> : null}
            {node.output ? (
              <div className="tool-output">
                <span>{t('输出')}</span>
                <pre>{node.output}</pre>
              </div>
            ) : null}
          </>
        )}
      </Collapsible.Content>
    </Collapsible.Root>
  )
})

const AssistantNode = memo(function AssistantNode({
  node,
  snapshot,
  showActions,
  latest = false,
  receipt
}: {
  node: Extract<ConversationNode, { type: 'assistant' }>
  snapshot: AgentSnapshot
  showActions: boolean
  /** The newest reply keeps its actions visible; older ones reveal them on hover. */
  latest?: boolean
  /** The turn's file changes close the reply, above its actions. */
  receipt?: React.ReactNode
}): React.JSX.Element {
  return (
    <article
      className={`assistant-node${node.streaming ? ' is-streaming' : ''}${latest ? ' is-latest' : ''}`}
    >
      <Markdown identity={node.id} streaming={node.streaming}>
        {node.markdown}
      </Markdown>
      {receipt}
      {showActions ? <MessageActions node={node} snapshot={snapshot} /> : null}
    </article>
  )
})

function NodeFlow({
  nodes,
  snapshot,
  approvals,
  onApproval,
  onInspectSubagent
}: {
  nodes: ConversationNode[]
  snapshot: AgentSnapshot
  approvals: ApprovalRequest[]
  onApproval: ApprovalHandler
  onInspectSubagent?: (child: SubagentSummary) => void
}): React.JSX.Element {
  const liveSessions = usePiStore((state) => state.liveSessions)
  const scopedLiveSessions = useMemo(
    () =>
      liveSessions.filter((session) => {
        const relation = session.sessionTask
        return (
          !relation ||
          (relation.parentWorkerId === snapshot.desktopScope?.workerId &&
            (relation.parentSessionId === undefined ||
              relation.parentSessionId === snapshot.sessionId) &&
            (relation.parentGeneration === undefined ||
              relation.parentGeneration === snapshot.generation))
        )
      }),
    [liveSessions, snapshot.desktopScope?.workerId, snapshot.sessionId, snapshot.generation]
  )
  const childrenById = useMemo(
    () => conversationSubagents(nodes, scopedLiveSessions),
    [nodes, scopedLiveSessions]
  )
  const edit = useSessionEdit()
  const lastReplyBlocks = useMemo(() => {
    const blocks = new Map<string, ConversationNode>()
    for (const node of nodes) {
      if (node.type === 'assistant' && node.canonicalEntryId) {
        blocks.set(node.canonicalEntryId, node)
      }
    }
    return blocks
  }, [nodes])
  const latestReply = useMemo(() => nodes.findLast((node) => node.type === 'assistant'), [nodes])
  const inlineEdit =
    edit.scope &&
    nodes.some((node) => node.type === 'user' && node.canonicalEntryId === edit.scope!.entryId)
  const groups = useMemo(() => groupConversationWork(nodes), [nodes])
  const turnChanges = useMemo(
    () => changesByTurnEnd(groups, snapshot.busy),
    [groups, snapshot.busy]
  )
  const projectPath = snapshot.project?.path
  return (
    <div className="node-flow">
      {groups.map((group, index) => {
        const receipt = turnChanges.get(index)
        const card = receipt ? (
          <TurnChanges
            files={receipt.files}
            projectPath={projectPath}
            checkpoint={turnCheckpoint(receipt.entryId)}
          />
        ) : null
        // A turn that ends in a reply carries its file changes inside that reply.
        if (card && group.kind === 'node' && group.node.type === 'assistant')
          return <Fragment key={group.key}>{renderGroup(group, index, card)}</Fragment>
        return (
          <Fragment key={group.key}>
            {renderGroup(group, index)}
            {card}
          </Fragment>
        )
      })}
      {!inlineEdit && edit.phase !== 'closed' ? <UserMessageEdit /> : null}
    </div>
  )

  function turnCheckpoint(entryId: string | undefined): TurnCheckpoint | undefined {
    const state = entryId && snapshot.checkpoints?.find((item) => item.entryId === entryId)
    if (!state || !snapshot.sessionId) return undefined
    return {
      entryId: state.entryId,
      state: state.state,
      sessionId: snapshot.sessionId,
      generation: snapshot.generation,
      blockedReason: snapshot.busy || approvals.length ? t('请等待当前任务结束后再撤销') : null
    }
  }

  function renderGroup(
    group: ConversationWorkGroup,
    index: number,
    receipt?: React.ReactNode
  ): React.ReactNode {
    if (group.kind === 'work')
      return (
        <WorkSummary
          key={group.key}
          nodes={group.nodes}
          running={snapshot.busy && index === groups.length - 1}
        >
          {group.nodes.map((node) =>
            node.type === 'think' ? (
              <ThinkNode key={node.presentationIdentity ?? node.id} node={node} />
            ) : (
              <ToolNode
                key={node.presentationIdentity ?? node.id}
                node={node}
                activeApproval={currentToolApproval(node, approvals)}
                projectPath={projectPath}
                onApproval={onApproval}
              />
            )
          )}
        </WorkSummary>
      )
    const node = group.node
    const key = node.presentationIdentity ?? node.id
    // Pi keeps each retry failure in canonical history. Collapse only adjacent identical
    // errors visually; user/assistant/tool boundaries still preserve separate failures.
    const nextGroup = groups[index + 1]
    const next = nextGroup?.kind === 'node' ? nextGroup.node : undefined
    if (node.type === 'error' && next?.type === 'error' && node.message === next.message)
      return null
    if (node.type === 'user') {
      return (
        <div className="user-row" key={key} data-user-node-id={node.id} tabIndex={-1}>
          <div className="user-node">
            <TextContextMessage text={node.text} />
            {node.imageCount ? (
              <span className="user-image-note">
                {node.imageCount} {t('张图片')}
              </span>
            ) : null}
          </div>
          <MessageActions node={node} snapshot={snapshot} />
          {edit.scope?.entryId === node.canonicalEntryId ? <UserMessageEdit /> : null}
        </div>
      )
    }
    if (node.type === 'assistant') {
      return (
        <AssistantNode
          key={key}
          node={node}
          snapshot={snapshot}
          receipt={receipt}
          latest={node === latestReply}
          showActions={
            !node.streaming &&
            !!node.canonicalEntryId &&
            lastReplyBlocks.get(node.canonicalEntryId) === node
          }
        />
      )
    }
    if (node.type === 'think') return <ThinkNode key={key} node={node} />
    if (node.type === 'model') {
      // Keep initial metadata in canonical history; it is not a conversation divider.
      // A choice made before the first message is setup, not a switch.
      if (
        node.initial ||
        !groups.slice(0, index).some((item) => item.kind === 'node' && item.node.type === 'user')
      )
        return null
      return (
        <div className="history-note is-model-switch" key={key} role="note">
          <ArrowRightLeft size={13} aria-hidden="true" />
          <span>
            {t('模型切换 · {provider} / {modelId}', {
              provider: node.provider,
              modelId: node.modelId
            })}
          </span>
        </div>
      )
    }
    if (node.type === 'compaction') {
      return (
        <div className="history-note is-compaction" key={key} role="note">
          <Archive size={13} aria-hidden="true" />
          <span>{t('上下文已压缩，历史消息仍保留')}</span>
        </div>
      )
    }
    if (node.type === 'tool') {
      if (node.subagent)
        return (
          <SubagentTool
            key={key}
            node={node}
            childrenById={childrenById}
            onInspect={onInspectSubagent}
          />
        )
      const activeApproval = currentToolApproval(node, approvals)
      return (
        <ToolNode
          key={key}
          node={node}
          activeApproval={activeApproval}
          projectPath={projectPath}
          onApproval={onApproval}
        />
      )
    }
    return (
      <div className={node.type === 'stopped' ? 'stopped-node' : 'error-node'} key={key}>
        {node.type === 'stopped' ? <Square size={13} /> : <CircleAlert size={15} />}
        {node.message}
      </div>
    )
  }
}

/** Index of each turn's last group → files that turn changed. The running turn is still
 * accumulating, so its receipt waits until the agent settles. */
function changesByTurnEnd(
  groups: readonly ConversationWorkGroup[],
  busy: boolean
): Map<number, { files: TurnFileChange[]; entryId?: string }> {
  const receipts = new Map<number, { files: TurnFileChange[]; entryId?: string }>()
  let turn: ConversationNode[] = []
  let entryId: string | undefined
  const flush = (end: number): void => {
    const files = summarizeTurnChanges(turn)
    if (files.length) receipts.set(end, { files, entryId })
    turn = []
  }
  groups.forEach((group, index) => {
    if (group.kind === 'node' && group.node.type === 'user') {
      if (index > 0) flush(index - 1)
      entryId = group.node.canonicalEntryId
    }
    if (group.kind === 'work') turn.push(...group.nodes)
  })
  if (!busy) flush(groups.length - 1)
  return receipts
}

function TextContextMessage({ text }: { text: string }): React.JSX.Element {
  const context = useMemo(() => parseTextContext(text), [text])
  if (!context) return <>{text}</>
  return (
    <>
      {context.text ? <div>{context.text}</div> : null}
      {context.files.map((file, index) => (
        <details className="text-context-file" key={index}>
          <summary>
            {t('{name} · 文本 · {toLocaleString} 字节 · 已发送快照', {
              name: file.name,
              toLocaleString: file.size.toLocaleString()
            })}
          </summary>
          <pre>{file.text || t('（空文件）')}</pre>
        </details>
      ))}
    </>
  )
}

function ContextMeter({ metrics }: { metrics: UsageMetrics }): React.JSX.Element {
  const display = contextDisplay(metrics)
  const runtimeRows = runtimeMetricsDisplay(metrics)

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className="context-control"
          style={
            display.percent === null
              ? undefined
              : ({ '--context-angle': `${display.percent * 3.6}deg` } as CSSProperties)
          }
          type="button"
          title={t('查看上下文与用量')}
          aria-label={display.ariaLabel}
        >
          <span
            className={`context-meter${display.percent === null ? ' is-unknown' : ''}`}
            aria-hidden="true"
          />
          <span>{display.percent === null ? '—' : `${Math.round(display.percent)}%`}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="metric-popover"
          sideOffset={9}
          align="end"
          aria-label={t('上下文与用量详情')}
        >
          <div className="popover-heading">
            <strong>{t('上下文')}</strong>
            <span>
              {display.percent === null ? t('用量未知') : `${display.percent.toFixed(1)}%`}
            </span>
          </div>
          <dl className="metric-list">
            <div>
              <dt>{t('已用 token')}</dt>
              <dd>{display.tokens}</dd>
            </div>
            <div>
              <dt>{t('上下文窗口')}</dt>
              <dd>{display.window}</dd>
            </div>
          </dl>

          <div className="metric-group">
            <span>{t('会话累计')}</span>
            <dl className="metric-list">
              <div>
                <dt>{t('输入')}</dt>
                <dd>{formatTokens(metrics.input)} token</dd>
              </div>
              <div>
                <dt>{t('输出')}</dt>
                <dd>{formatTokens(metrics.output)} token</dd>
              </div>
              <div>
                <dt>{t('缓存读取')}</dt>
                <dd>{formatTokens(metrics.cacheRead)} token</dd>
              </div>
              <div>
                <dt>{t('缓存写入')}</dt>
                <dd>{formatTokens(metrics.cacheWrite)} token</dd>
              </div>
            </dl>
            {metrics.usageIncomplete ? (
              <small>{t('中断用量未知 · 累计仅含已报告用量')}</small>
            ) : null}
          </div>

          <div className="metric-group">
            <span>{t('本次运行期实测')}</span>
            <dl className="metric-list">
              {runtimeRows.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <small>{t('数据缺失或应用重启后显示未知。')}</small>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function QueuePopover({
  followUp,
  onClear
}: {
  followUp: string[]
  onClear: () => void
}): React.JSX.Element | null {
  if (followUp.length === 0) return null

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className="queue-button"
          type="button"
          title={t('查看待发送队列（{length} 条）', { length: followUp.length })}
          aria-label={t('查看待发送队列，共 {length} 条', { length: followUp.length })}
        >
          <ListPlus size={13} />
          <span>{followUp.length}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="queue-popover"
          sideOffset={9}
          align="end"
          aria-label={t('待发送队列')}
        >
          <div className="popover-heading">
            <strong>{t('待发送队列')}</strong>
            <span>
              {followUp.length} {t('条')}
            </span>
          </div>
          <p>{t('当前 agent run 完全结束后发送。')}</p>
          <ol className="queue-list">
            {followUp.map((text, index) => (
              <li key={`${index}-${text}`}>
                <span>{index + 1}</span>
                <p>{text}</p>
              </li>
            ))}
          </ol>
          <button className="queue-clear" type="button" onClick={onClear}>
            {t('清空全部')}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function Stats({ metrics }: { metrics: UsageMetrics }): React.JSX.Element | null {
  const groups = composerStatsDisplay(metrics)
  if (!groups) return null
  return (
    <div className="composer-stats" aria-label={groups.join('；')}>
      {groups.map((group) => (
        <span key={group}>{group}</span>
      ))}
    </div>
  )
}

function Composer({
  snapshot,
  onSend,
  onAbort,
  onClearQueue,
  onPermissionChange,
  onChooseModel,
  onLogin,
  onOpenSettings
}: Pick<
  ConversationProps,
  | 'snapshot'
  | 'onSend'
  | 'onAbort'
  | 'onClearQueue'
  | 'onPermissionChange'
  | 'onChooseModel'
  | 'onLogin'
  | 'onOpenSettings'
>): React.JSX.Element {
  const draftKey = JSON.stringify([snapshot.project?.path, snapshot.sessionId])
  const runElapsed = useRunElapsed(snapshot.sessionId, snapshot.busy)
  const desktopSettings = useDesktopSettings((state) => state.settings)
  const preferencesLoaded = useDesktopSettings((state) => state.hasLoaded)
  const forkPending = usePiStore((state) => state.forkPending)
  const editOpen = useSessionEdit((state) => state.phase !== 'closed')
  const attachments = useTextAttachments()
  const capturedAttachmentDraft = useRef<{ key: string; version: number | undefined } | null>(null)
  const [drafts, setDrafts] = useState<Record<string, { text: string; version: number }>>({})
  const skillInsertion = useSkillInsertion((state) => state.pending)
  const previousSession = useRef(snapshot)
  useEffect(() => {
    const previous = previousSession.current
    previousSession.current = snapshot
    // An unsaved empty Pi session receives a new ID after Host recovery.
    if (
      !previous.ready &&
      snapshot.ready &&
      !previous.activeSessionPath &&
      previous.project?.path === snapshot.project?.path &&
      previous.sessionId !== snapshot.sessionId
    ) {
      const previousKey = JSON.stringify([previous.project?.path, previous.sessionId])
      setDrafts((current) => {
        const previousDraft = current[previousKey]
        if (!previousDraft || current[draftKey]?.text) return current
        const next = { ...current, [draftKey]: previousDraft }
        delete next[previousKey]
        return next
      })
    }
  }, [snapshot, draftKey])
  const entry = drafts[draftKey]
  const draft = entry?.text ?? ''
  const setDraft = (text: string): void => {
    setDrafts((current) => ({
      ...current,
      [draftKey]: { text, version: (current[draftKey]?.version ?? 0) + 1 }
    }))
  }
  const pendingKeys = useRef(new Set<string>())
  const [pending, setPending] = useState<string[]>([])
  const submitting = pending.includes(draftKey)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const skillPicker = useRef<SkillPickerHandle>(null)
  const [skillMenuState, setSkillMenuState] = useState<SkillMenuState>({})
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const canCompose = Boolean(
    snapshot.ready &&
    snapshot.project &&
    snapshot.modelAvailability === 'available' &&
    snapshot.composeBlockReason === null &&
    !forkPending
  )
  const skillInsertionBlocked =
    !canCompose ||
    editOpen ||
    submitting ||
    Boolean(
      attachments.files.length ||
      attachments.staging ||
      attachments.sending ||
      attachments.submission
    )
  const skillAttachmentConflict =
    /^\/skill:/.test(draft.trimStart()) && attachments.files.length > 0

  useEffect(() => {
    if (!skillInsertion) return
    const request = useSkillInsertion.getState().consume()
    if (!request || skillInsertionBlocked) return
    const identity = skillDraftIdentity(snapshot)
    setDrafts((current) => {
      const entry = current[draftKey]
      const text = insertSkillDraft(entry?.text ?? '', request, identity)
      return text === null
        ? current
        : { ...current, [draftKey]: { text, version: (entry?.version ?? 0) + 1 } }
    })
    textarea.current?.focus()
  }, [skillInsertion, skillInsertionBlocked, snapshot, draftKey])

  const prefill = useComposerPrefill((state) => state.pending)
  useEffect(() => {
    // Kept until the composer can take it, e.g. while a new conversation is still starting.
    if (!prefill || !canCompose || editOpen || submitting) return
    const mode = useComposerPrefill.getState().mode
    const request = useComposerPrefill.getState().consume()
    if (!request) return
    const text =
      mode === 'append' && draft.trim() ? `${draft.replace(/\s+$/u, '')}\n\n${request}` : request
    setDraft(text)
    requestAnimationFrame(() => {
      const input = textarea.current
      if (!input) return
      input.focus()
      input.setSelectionRange(text.length, text.length)
    })
    // setDraft is recreated each render; the prefill value is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, canCompose, editOpen, submitting])

  useEffect(() => {
    const input = textarea.current
    if (!input) return
    input.style.height = '0px'
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`
  }, [draft])

  const submit = (): void => {
    if (useSessionEdit.getState().phase !== 'closed') return
    if (
      skillAttachmentConflict ||
      (snapshot.busy && snapshot.runtime && !snapshot.runtime.features.includes('queue'))
    )
      return
    if (!snapshot.ready || pendingKeys.current.has(draftKey) || usePiStore.getState().forkPending)
      return
    if (attachments.files.length) {
      if (
        !canCompose ||
        snapshot.busy ||
        attachments.staging ||
        attachments.sending ||
        attachments.submission
      )
        return
      capturedAttachmentDraft.current = { key: draftKey, version: entry?.version }
      void submitAttachments(false)
      return
    }
    if (!canCompose) {
      onOpenSettings()
      return
    }
    if (!draft.trim()) return
    const version = entry?.version
    pendingKeys.current.add(draftKey)
    setPending([...pendingKeys.current])
    void onSend(draft.trim(), { sessionId: snapshot.sessionId!, generation: snapshot.generation })
      .then((accepted) => {
        if (!accepted) return
        setDrafts((current) => {
          if (current[draftKey]?.version !== version) return current
          return { ...current, [draftKey]: { text: '', version: (version ?? 0) + 1 } }
        })
      })
      .finally(() => {
        pendingKeys.current.delete(draftKey)
        setPending([...pendingKeys.current])
      })
  }

  const submitAttachments = async (query: boolean): Promise<void> => {
    const captured = capturedAttachmentDraft.current
    const receipt = await sendTextFiles(draft, query)
    if (receipt?.status !== 'accepted' || !captured) return
    setDrafts((current) => {
      if (current[captured.key]?.version !== captured.version) return current
      return { ...current, [captured.key]: { text: '', version: (captured.version ?? 0) + 1 } }
    })
    capturedAttachmentDraft.current = null
  }

  const lockLabel = !snapshot.ready
    ? t('Pi 引擎未连接')
    : snapshot.composeBlockReason === 'endpoint-runtime-unsynchronized'
      ? t('端点运行时未同步 · 检查配置并重新保存')
      : snapshot.composeBlockReason === 'endpoint-selection-invalidated'
        ? t('模型选择已失效 · 重新选择模型')
        : snapshot.composeBlockReason === 'project-required'
          ? t('先选择一个工作区')
          : snapshot.composeBlockReason === 'login-required'
            ? t('先连接一个模型账号')
            : snapshot.composeBlockReason === 'pinned-model-unavailable'
              ? t('此会话模型不可用 · 选择其他模型继续')
              : snapshot.composeBlockReason === 'model-unavailable'
                ? t('所选模型不可用 · 选择其他模型继续')
                : t('选择模型后才能发送')
  const lockAction =
    snapshot.composeBlockReason === 'login-required'
      ? onOpenSettings
      : snapshot.composeBlockReason === 'model-unavailable' ||
          snapshot.composeBlockReason === 'endpoint-selection-invalidated' ||
          snapshot.composeBlockReason === 'pinned-model-unavailable' ||
          snapshot.composeBlockReason === 'model-required'
        ? () => setModelMenuOpen(true)
        : snapshot.project
          ? onOpenSettings
          : undefined

  return (
    <div className="composer-wrap">
      <div className={`composer${canCompose ? '' : ' is-locked'}`}>
        {(!snapshot.runtime || snapshot.runtime.features.includes('skills')) && (
          <SkillPicker
            ref={skillPicker}
            snapshot={snapshot}
            draft={draft}
            disabled={skillInsertionBlocked}
            onMenuStateChange={setSkillMenuState}
            onInsert={(request) => useSkillInsertion.getState().request(request)}
          />
        )}
        {skillAttachmentConflict && (
          <p role="alert" className="inline-hint">
            {t('技能命令暂不能与文本附件一起发送，请先移除附件。')}
          </p>
        )}
        {!skillAttachmentConflict && /^\/skill:/.test(draft.trimStart()) && (
          <p className="inline-hint">
            {t('技能命令暂不能搭配文本附件；移除技能命令后可添加附件。')}
          </p>
        )}
        {!snapshot.ready ? (
          <div className="composer-lock is-static">
            <LockKeyhole size={14} />
            {lockLabel}
          </div>
        ) : !canCompose && lockAction ? (
          <button className="composer-lock" type="button" onClick={lockAction}>
            <LockKeyhole size={14} />
            {lockLabel}
          </button>
        ) : !canCompose ? (
          <div className="composer-lock is-static">
            <LockKeyhole size={14} />
            {lockLabel}
          </div>
        ) : null}
        {attachments.files.length ? (
          <ul className="attachment-chips" aria-label={t('已选择的文本文件')}>
            {attachments.files.map((file) => (
              <li key={file.id}>
                <FileText size={14} aria-hidden="true" />
                <span title={file.name}>
                  {file.name}
                  <small>
                    {t('文本 · {toLocaleString} 字节 · 内容快照', {
                      toLocaleString: file.size.toLocaleString()
                    })}
                  </small>
                </span>
                <button
                  type="button"
                  aria-label={t('移除 {name}', { name: file.name })}
                  disabled={
                    attachments.staging || attachments.sending || Boolean(attachments.submission)
                  }
                  onClick={() => void removeTextFile(file.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {attachments.staging ||
        attachments.message ||
        (attachments.files.length > 0 && snapshot.busy) ? (
          <div className="attachment-status" role="status">
            {attachments.staging
              ? t('正在读取文本文件…')
              : attachments.files.length > 0 && snapshot.busy
                ? t('文本附件仅支持空闲时发送，请等待当前任务结束；内容已保留。')
                : attachments.message}
            {attachments.submission && !attachments.sending ? (
              <button
                type="button"
                className="tool-chip"
                onClick={() => void submitAttachments(true)}
              >
                {t('查询原发送结果')}
              </button>
            ) : null}
          </div>
        ) : null}
        <textarea
          ref={textarea}
          className="composer-input"
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (skillPicker.current?.handleKeyDown(event)) return
            if (!preferencesLoaded) return
            if (event.keyCode === 229) return
            if (
              shouldSendOnKey(
                {
                  key: event.key,
                  shiftKey: event.shiftKey,
                  metaKey: event.metaKey,
                  ctrlKey: event.ctrlKey,
                  keyCode: event.keyCode,
                  isComposing: event.nativeEvent.isComposing
                },
                desktopSettings.sendShortcut
              )
            ) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={
            !preferencesLoaded
              ? t('发送偏好尚未读取，请使用发送按钮…')
              : snapshot.busy
                ? snapshot.runtime?.features.includes('queue')
                  ? t('补充指令，加入当前任务之后…')
                  : t('任务运行中，可先写下下一条指令…')
                : snapshot.runtime?.id === 'claude'
                  ? t('描述你想完成的任务…')
                  : t('给 Pi 一个任务，或输入 / 选择技能…')
          }
          title={t('{value} 发送，Shift + Enter 换行', {
            value: desktopSettings.sendShortcut === 'enter' ? 'Enter' : '⌘ / Ctrl + Enter'
          })}
          aria-label={t('任务输入')}
          aria-controls={skillMenuState.listId}
          aria-activedescendant={skillMenuState.activeId}
          aria-autocomplete="list"
          disabled={!canCompose}
        />
        <div className="composer-tools">
          {(!snapshot.runtime || snapshot.runtime.features.includes('attachments')) && (
            <button
              className="tool-chip icon-only"
              type="button"
              title={t('添加 UTF-8 文本文件（最多 4 个，单个 1 MiB，合计 2 MiB）')}
              aria-label={t('添加文本文件')}
              disabled={
                /^\/skill:/.test(draft.trimStart()) ||
                editOpen ||
                !snapshot.ready ||
                !snapshot.project ||
                attachments.staging ||
                attachments.sending ||
                Boolean(attachments.submission)
              }
              onClick={() => void stageTextFile()}
            >
              <Plus size={16} />
            </button>
          )}

          <ModelPicker
            snapshot={snapshot}
            open={modelMenuOpen}
            onOpenChange={setModelMenuOpen}
            onSelect={onChooseModel}
            onLogin={onLogin}
            onSettings={onOpenSettings}
          />
          <PermissionControl snapshot={snapshot} onPermissionChange={onPermissionChange} />

          <span className="composer-spacer" />
          <ContextMeter metrics={snapshot.metrics} />
          <QueuePopover followUp={snapshot.followUp} onClear={onClearQueue} />
          {runElapsed !== null ? (
            <span className="composer-elapsed" title={t('本次运行已用时间')}>
              {formatElapsed(runElapsed)}
            </span>
          ) : null}
          {snapshot.busy && (
            <button
              className="composer-stop"
              type="button"
              title={t('停止当前运行')}
              aria-label={t('停止当前运行')}
              disabled={!snapshot.ready}
              onClick={onAbort}
            >
              <Square size={12} fill="currentColor" />
              <span>{t('停止')}</span>
            </button>
          )}
          <button
            className="send"
            type="button"
            title={
              snapshot.busy
                ? snapshot.runtime?.features.includes('queue')
                  ? t('加入发送队列')
                  : t('等待当前任务结束后发送')
                : t('发送任务')
            }
            aria-label={snapshot.busy ? t('加入发送队列') : t('发送任务')}
            onClick={submit}
            disabled={
              submitting ||
              skillAttachmentConflict ||
              editOpen ||
              attachments.staging ||
              attachments.sending ||
              Boolean(attachments.submission) ||
              !canCompose ||
              (!draft.trim() && !attachments.files.length) ||
              (snapshot.busy &&
                (attachments.files.length > 0 ||
                  Boolean(snapshot.runtime && !snapshot.runtime.features.includes('queue'))))
            }
          >
            {snapshot.busy ? <ListPlus size={17} /> : <ArrowUp size={18} />}
          </button>
        </div>
      </div>
      {desktopSettings.showUsage ? <Stats metrics={snapshot.metrics} /> : null}
    </div>
  )
}

export default function Conversation(props: ConversationProps): React.JSX.Element {
  const { snapshot, approvals, loading, error, onApproval, onChooseProject } = props
  const liveSessions = usePiStore((state) => state.liveSessions)
  const childRelation = liveSessions.find(
    (session) => session.workerId === snapshot.desktopScope?.workerId
  )?.sessionTask
  const parentSession =
    childRelation &&
    liveSessions.find(
      (session) =>
        session.workerId === childRelation.parentWorkerId &&
        (childRelation.parentSessionId === undefined ||
          session.sessionId === childRelation.parentSessionId) &&
        (childRelation.parentGeneration === undefined ||
          session.generation === childRelation.parentGeneration)
    )
  const recentProject = props.recentProject
  // A model choice made before the first message is setup, not conversation content.
  const hasNodes = snapshot.nodes.some((node) => node.type !== 'model')
  const home = Boolean(snapshot.project) && !hasNodes && !loading
  const elapsed = useRunElapsed(snapshot.sessionId, snapshot.busy)
  const recentSessions = useMemo(
    () =>
      home
        ? snapshot.sessions
            .filter((session) => !session.active && session.messageCount > 0)
            .toSorted((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
            .slice(0, 3)
        : [],
    [home, snapshot.sessions]
  )
  const lastNode = snapshot.nodes.at(-1)
  const visibleError =
    error && !(lastNode?.type === 'error' && lastNode.message === error) ? error : null
  const sessionHeader = activeSessionHeader(
    snapshot.activeSessionPath,
    snapshot.sessions,
    snapshot.status
  )
  const scrollEnd = useRef<HTMLDivElement>(null)
  const scrollContainer = useRef<HTMLDivElement>(null)
  const contentAxis = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const navigationScroll = useRef(false)
  const navigationFrame = useRef<number | null>(null)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const scrollIdentity = JSON.stringify([snapshot.project?.path, snapshot.sessionId])
  const offscreenApproval = useOffscreenApproval(scrollContainer, approvals, scrollIdentity)
  const streamKey = useMemo(
    () =>
      snapshot.nodes.map((node) => ('markdown' in node ? node.markdown.length : node.id)).join(':'),
    [snapshot.nodes]
  )

  useEffect(() => {
    following.current = true
    setAwayFromBottom(false)
    navigationScroll.current = false
    return () => {
      if (navigationFrame.current !== null) window.cancelAnimationFrame(navigationFrame.current)
    }
  }, [scrollIdentity])

  useEffect(() => {
    if (!following.current) return undefined
    const frame = window.requestAnimationFrame(() => {
      if (following.current)
        scrollEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [scrollIdentity, snapshot.busy, streamKey, approvals])

  // While a run is live, content keeps growing after render (diffs and approval cards lay
  // out asynchronously). A reader who is following stays pinned to the end through that.
  useEffect(() => {
    const content = contentAxis.current
    const scroller = scrollContainer.current
    if (!snapshot.busy || !content || !scroller) return undefined
    const observer = new ResizeObserver(() => {
      if (following.current && !navigationScroll.current) scroller.scrollTop = scroller.scrollHeight
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [snapshot.busy])

  return (
    <main className={`conversation${hasNodes ? ' has-session' : home ? ' is-home' : ''}`}>
      {snapshot.project ? (
        <header className="conversation-head">
          <span className="conversation-session-title" title={sessionHeader.title}>
            {sessionHeader.title}
          </span>
          <span className="conversation-head-meta">
            <span className={`conversation-status is-${sessionHeader.status.tone}`}>
              <i
                className={`session-status-dot is-${sessionHeader.status.tone}`}
                aria-hidden="true"
              />
              {sessionHeader.status.label}
              {elapsed !== null && sessionHeader.status.tone === 'running' ? (
                <span className="conversation-elapsed"> · {formatElapsed(elapsed)}</span>
              ) : null}
            </span>
          </span>
          <div className="conversation-actions">
            {snapshot.sessions.find((session) => session.active)?.parentSessionPath ? (
              <button
                className="session-action session-parent-action"
                aria-label={t('来源会话')}
                title={t('来源会话')}
                onClick={() =>
                  props.onOpenSession(
                    snapshot.sessions.find((session) => session.active)!.parentSessionPath!
                  )
                }
              >
                <ArrowLeft size={13} />
                <span>{t('来源会话')}</span>
              </button>
            ) : snapshot.sessions.find((session) => session.active)?.parentUnavailable ? (
              <span className="session-parent-unavailable">{t('来源会话当前不可用')}</span>
            ) : null}
            <SessionFork
              key={JSON.stringify([
                'fork',
                snapshot.sessionId,
                snapshot.generation,
                snapshot.desktopScope ?? null
              ])}
              snapshot={snapshot}
            />
            <SessionActions
              key={JSON.stringify(['rename', snapshot.sessionId, snapshot.generation])}
              snapshot={snapshot}
              title={sessionHeader.title}
            />
            <QuestionNavigation
              key={JSON.stringify(['questions', snapshot.sessionId, snapshot.generation])}
              nodes={snapshot.nodes}
              onSelect={(id) => {
                const row = Array.from(
                  scrollContainer.current?.querySelectorAll<HTMLElement>('[data-user-node-id]') ??
                    []
                ).find((element) => element.dataset.userNodeId === id)
                if (!row) return
                following.current = false
                setAwayFromBottom(true)
                // A programmatic jump near the tail must not resume stream following.
                // Expire after layout, even when the jump emitted no scroll event.
                navigationScroll.current = true
                if (navigationFrame.current !== null)
                  window.cancelAnimationFrame(navigationFrame.current)
                row.focus({ preventScroll: true })
                row.scrollIntoView({ block: 'start', behavior: 'auto' })
                navigationFrame.current = window.requestAnimationFrame(() => {
                  navigationFrame.current = window.requestAnimationFrame(() => {
                    navigationScroll.current = false
                    navigationFrame.current = null
                  })
                })
              }}
            />
          </div>
        </header>
      ) : null}

      <div
        className="conversation-scroll"
        ref={scrollContainer}
        onWheel={() => {
          navigationScroll.current = false
        }}
        onPointerDown={() => {
          navigationScroll.current = false
        }}
        onKeyDown={() => {
          navigationScroll.current = false
        }}
        onScroll={(event) => {
          if (navigationScroll.current) return
          const element = event.currentTarget
          const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80
          following.current = nearBottom
          setAwayFromBottom(!nearBottom)
        }}
      >
        <div className="content-axis" ref={contentAxis}>
          {parentSession?.sessionPath ? (
            <button
              className="subagent-parent-link"
              type="button"
              onClick={() => props.onOpenSession(parentSession.sessionPath!)}
            >
              <ArrowLeft size={14} aria-hidden="true" />
              {t('返回父会话 ·')} {parentSession.title || t('主 Agent')}
            </button>
          ) : null}
          {!hasNodes ? (
            <div className="hero-copy">
              <h1>
                {snapshot.project
                  ? t('今天，我们完成什么？')
                  : recentProject
                    ? t('继续上次的工作。')
                    : t('从一个项目开始。')}
              </h1>
              <p>
                {loading
                  ? t('正在连接 Agent 引擎…')
                  : snapshot.project
                    ? t('描述你的目标，一起探索、实现与验证。')
                    : recentProject
                      ? recentProject.sessionTitle
                        ? `${recentProject.name} · ${recentProject.sessionTitle}`
                        : t('返回 {name}，开始新的会话。', { name: recentProject.name })
                      : t('选择一个项目文件夹，开始工作。')}
              </p>
              {!snapshot.project ? (
                <div className="hero-project-actions">
                  {recentProject && props.onContinueProject ? (
                    <button
                      className="hero-project-cta"
                      type="button"
                      disabled={!snapshot.ready || props.projectNavigationPending}
                      onClick={() =>
                        props.onContinueProject?.(recentProject.path, recentProject.sessionPath)
                      }
                    >
                      <FolderOpen size={16} />
                      {props.projectNavigationPending
                        ? t('正在打开…')
                        : recentProject.sessionPath
                          ? t('继续最近会话')
                          : t('打开最近项目')}
                    </button>
                  ) : null}
                  <button
                    className={recentProject ? 'hero-project-secondary' : 'hero-project-cta'}
                    type="button"
                    disabled={!snapshot.ready || props.projectNavigationPending}
                    onClick={onChooseProject}
                  >
                    {!recentProject ? <FolderOpen size={16} /> : null}
                    {recentProject ? t('选择其他文件夹') : t('选择工作区')}
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <NodeFlow
              key={scrollIdentity}
              nodes={snapshot.nodes}
              snapshot={snapshot}
              approvals={approvals}
              onApproval={onApproval}
              onInspectSubagent={props.onInspectSubagent}
            />
          )}
          {!snapshot.nodes.length ? <UserMessageEdit /> : null}
          {visibleError ? (
            <div className="client-error">
              <CircleAlert size={15} />
              {visibleError}
            </div>
          ) : null}
          <ConversationActivity
            nodes={snapshot.nodes}
            busy={snapshot.busy}
            approvals={approvals.length}
          />
          <div ref={scrollEnd} />
        </div>
      </div>

      <div className="composer-axis">
        {offscreenApproval ? (
          <button
            type="button"
            className="approval-jump"
            aria-label={t('查看待确认操作，共 {length} 项', { length: approvals.length })}
            onClick={() => {
              const card = Array.from(
                scrollContainer.current?.querySelectorAll<HTMLElement>('[data-approval-id]') ?? []
              ).find((element) => element.dataset.approvalId === offscreenApproval.id)
              following.current = false
              navigationScroll.current = true
              const target = card?.querySelector('[data-approval-actions]') ?? card
              target?.scrollIntoView({ block: 'center', behavior: 'auto' })
              card?.focus({ preventScroll: true })
              if (navigationFrame.current !== null)
                window.cancelAnimationFrame(navigationFrame.current)
              navigationFrame.current = window.requestAnimationFrame(() => {
                navigationFrame.current = window.requestAnimationFrame(() => {
                  navigationScroll.current = false
                  navigationFrame.current = null
                  const element = scrollContainer.current
                  if (!element) return
                  const nearBottom =
                    element.scrollHeight - element.scrollTop - element.clientHeight < 80
                  following.current = nearBottom
                  setAwayFromBottom(!nearBottom)
                })
              })
            }}
          >
            <CircleAlert size={14} aria-hidden="true" />
            <span>
              {t('有 {length} 项操作需要确认 · {value}', {
                length: approvals.length,
                value: approvalSummary(offscreenApproval)
              })}
            </span>
            <span className="approval-jump-action">
              {t('查看')} <ChevronRight size={13} aria-hidden="true" />
            </span>
          </button>
        ) : null}
        {!snapshot.ready && !loading ? (
          <button className="tool-chip" disabled={props.reconnecting} onClick={props.onReconnect}>
            {props.reconnecting ? t('正在重新连接…') : t('重新连接引擎')}
          </button>
        ) : null}
        {awayFromBottom ? (
          <button
            className="conversation-jump-bottom"
            aria-label={t('回到底部')}
            title={t('回到底部')}
            onClick={() => {
              following.current = true
              navigationScroll.current = false
              setAwayFromBottom(false)
              const element = scrollContainer.current
              if (element) element.scrollTop = element.scrollHeight
            }}
          >
            <ArrowDown size={16} aria-hidden="true" />
          </button>
        ) : null}
        <Composer {...props} />
        {home ? (
          <div className="home-below">
            {snapshot.ready && snapshot.composeBlockReason === 'login-required' ? (
              <ConnectChoices runtimeId={snapshot.runtime?.id} onConnect={props.onConnect} />
            ) : (
              <div className="hero-starters" aria-label={t('快速开始')}>
                {STARTERS.map(({ icon: Icon, label, prompt }) => (
                  <button
                    key={label}
                    type="button"
                    className="hero-starter"
                    onClick={() => useComposerPrefill.getState().request(prompt)}
                  >
                    <Icon size={15} aria-hidden="true" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            )}
            {recentSessions.length > 0 ? (
              <nav className="home-recent" aria-label={t('最近会话')}>
                <span className="home-recent-label">{t('最近会话')}</span>
                {recentSessions.map((session) => (
                  <button
                    key={session.path}
                    type="button"
                    className="home-recent-item"
                    onClick={() => props.onOpenSession(session.path)}
                  >
                    <MessageSquare size={14} aria-hidden="true" />
                    <span className="home-recent-title">{session.title}</span>
                    <span className="home-recent-time">{relativeTime(session.modified)}</span>
                  </button>
                ))}
              </nav>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  )
}
