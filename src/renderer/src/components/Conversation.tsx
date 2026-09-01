import { memo, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react'
import * as Collapsible from '@radix-ui/react-collapsible'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Popover from '@radix-ui/react-popover'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowUp,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  FileDiff,
  FileText,
  FolderOpen,
  Globe2,
  LockKeyhole,
  ListPlus,
  Plus,
  Search,
  Settings2,
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
import {
  composerModelSelectionReducer,
  initialComposerModelSelection,
  sessionHasTranscript
} from '../store/composer-model-selection'
import {
  composerStatsDisplay,
  contextDisplay,
  formatTokens,
  runtimeMetricsDisplay,
  toolMetaDisplay
} from '../store/conversation-presentation'

type ConversationProps = {
  snapshot: AgentSnapshot
  approvals: ApprovalRequest[]
  loading: boolean
  error?: string | null
  onChooseProject: () => void
  onSend: (text: string) => void
  onAbort: () => void
  onClearQueue: () => void
  onPermissionChange: (permission: PermissionMode) => void
  onChooseModel: (providerId: string, modelId: string) => void
  onLogin: () => void
  onOpenSettings: () => void
  onApproval: (id: string, allow: boolean) => void
}

const TOOL_ICON: Record<ToolIntent, typeof TerminalSquare> = {
  terminal: TerminalSquare,
  read: FileText,
  diff: FileDiff,
  search: Search,
  web: Globe2,
  generic: Wrench
}

const STATUS_LABEL = {
  queued: '排队中',
  'awaiting-approval': '等待确认',
  running: '运行中',
  success: '完成',
  error: '失败',
  blocked: '已拒绝'
} as const

const Markdown = memo(function Markdown({ children }: { children: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ children: label, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer">
            {label}
          </a>
        ),
        code: ({ children: code, className }) => <code className={className}>{code}</code>
      }}
    >
      {children}
    </ReactMarkdown>
  )
})

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
        <span>{node.streaming ? '正在思考…' : '思考了一会儿'}</span>
        {!open ? <small>{node.text.replace(/\s+/g, ' ').slice(0, 72)}</small> : null}
      </Collapsible.Trigger>
      <Collapsible.Content className="think-content">{node.text}</Collapsible.Content>
    </Collapsible.Root>
  )
})

const ToolNode = memo(function ToolNode({
  node,
  activeApproval,
  onApproval
}: {
  node: Extract<ConversationNode, { type: 'tool' }>
  activeApproval: ApprovalRequest | null
  onApproval: (id: string, allow: boolean) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const Icon = TOOL_ICON[node.intent]
  const meta = toolMetaDisplay(node)
  return (
    <Collapsible.Root
      className={`tool-node is-${node.status}`}
      open={open || Boolean(activeApproval)}
      onOpenChange={setOpen}
    >
      <Collapsible.Trigger className="tool-trigger">
        <Icon size={15} />
        <span className="tool-title">{node.title}</span>
        <span className="tool-status">{STATUS_LABEL[node.status]}</span>
        {meta.map((item) => (
          <span className="tool-meta" key={item}>
            {item}
          </span>
        ))}
        <ChevronRight className="tool-chevron" size={14} />
      </Collapsible.Trigger>
      <Collapsible.Content className="tool-detail">
        {activeApproval ? (
          <div className="approval-card">
            <div>
              <strong>允许这次操作？</strong>
              <p>Ask 模式会在写文件和运行命令前停下来。</p>
            </div>
            <pre>{activeApproval.detail}</pre>
            <div className="approval-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => onApproval(activeApproval.id, false)}
              >
                拒绝
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => onApproval(activeApproval.id, true)}
              >
                允许一次
              </button>
            </div>
          </div>
        ) : (
          <>
            {node.detail ? <pre>{node.detail}</pre> : null}
            {node.output ? (
              <div className="tool-output">
                <span>输出</span>
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
  node
}: {
  node: Extract<ConversationNode, { type: 'assistant' }>
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current)
    },
    []
  )

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(node.markdown)
    setCopied(true)
    if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <article className={`assistant-node${node.streaming ? ' is-streaming' : ''}`}>
      <button
        className="assistant-copy"
        type="button"
        title={copied ? '已复制' : '复制回复'}
        aria-label={copied ? '已复制' : '复制回复'}
        onClick={() => void copy()}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        <span>{copied ? '已复制' : '复制'}</span>
      </button>
      <Markdown>{node.markdown}</Markdown>
    </article>
  )
})

function NodeFlow({
  nodes,
  approvals,
  onApproval
}: {
  nodes: ConversationNode[]
  approvals: ApprovalRequest[]
  onApproval: (id: string, allow: boolean) => void
}): React.JSX.Element {
  return (
    <div className="node-flow">
      {nodes.map((node) => {
        if (node.type === 'user') {
          return (
            <div className="user-row" key={node.id}>
              <div className="user-node">{node.text}</div>
            </div>
          )
        }
        if (node.type === 'assistant') {
          return <AssistantNode key={node.id} node={node} />
        }
        if (node.type === 'think') return <ThinkNode key={node.id} node={node} />
        if (node.type === 'tool') {
          const activeApproval =
            approvals.find((request) => request.toolCallId === node.toolCallId) ?? null
          return (
            <ToolNode
              key={node.id}
              node={node}
              activeApproval={activeApproval}
              onApproval={onApproval}
            />
          )
        }
        return (
          <div className="error-node" key={node.id}>
            <CircleAlert size={15} />
            {node.message}
          </div>
        )
      })}
    </div>
  )
}

function MenuContent({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="dropdown-content" sideOffset={7} align="start">
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  )
}

function ContextMeter({ metrics }: { metrics: UsageMetrics }): React.JSX.Element {
  const display = contextDisplay(metrics)
  const runtimeRows = runtimeMetricsDisplay(metrics)

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className={`context-meter${display.percent === null ? ' is-unknown' : ''}`}
          style={
            display.percent === null
              ? undefined
              : ({ '--context-angle': `${display.percent * 3.6}deg` } as CSSProperties)
          }
          type="button"
          title="查看上下文与用量"
          aria-label={display.ariaLabel}
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="metric-popover"
          sideOffset={9}
          align="end"
          aria-label="上下文与用量详情"
        >
          <div className="popover-heading">
            <strong>上下文</strong>
            <span>{display.percent === null ? '用量未知' : `${display.percent.toFixed(1)}%`}</span>
          </div>
          <dl className="metric-list">
            <div>
              <dt>已用 token</dt>
              <dd>{display.tokens}</dd>
            </div>
            <div>
              <dt>上下文窗口</dt>
              <dd>{display.window}</dd>
            </div>
          </dl>

          <div className="metric-group">
            <span>会话累计</span>
            <dl className="metric-list">
              <div>
                <dt>输入</dt>
                <dd>{formatTokens(metrics.input)} token</dd>
              </div>
              <div>
                <dt>输出</dt>
                <dd>{formatTokens(metrics.output)} token</dd>
              </div>
              <div>
                <dt>缓存读取</dt>
                <dd>{formatTokens(metrics.cacheRead)} token</dd>
              </div>
              <div>
                <dt>缓存写入</dt>
                <dd>{formatTokens(metrics.cacheWrite)} token</dd>
              </div>
            </dl>
          </div>

          <div className="metric-group">
            <span>本次运行期实测</span>
            <dl className="metric-list">
              {runtimeRows.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <small>数据缺失或应用重启后显示未知。</small>
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
          title={`查看待发送队列（${followUp.length} 条）`}
          aria-label={`查看待发送队列，共 ${followUp.length} 条`}
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
          aria-label="待发送队列"
        >
          <div className="popover-heading">
            <strong>待发送队列</strong>
            <span>{followUp.length} 条</span>
          </div>
          <p>当前 agent run 完全结束后发送。</p>
          <ol className="queue-list">
            {followUp.map((text, index) => (
              <li key={`${index}-${text}`}>
                <span>{index + 1}</span>
                <p>{text}</p>
              </li>
            ))}
          </ol>
          <button className="queue-clear" type="button" onClick={onClear}>
            清空全部
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
  const [draft, setDraft] = useState('')
  const [modelSelection, dispatchModelSelection] = useReducer(
    composerModelSelectionReducer,
    snapshot,
    initialComposerModelSelection
  )
  const textarea = useRef<HTMLTextAreaElement>(null)
  const activeModel = snapshot.models.find(
    (item) => item.provider === snapshot.activeProvider && item.id === snapshot.activeModel
  )
  const stagedAccount = snapshot.accounts.find((item) => item.id === modelSelection.stagedProvider)
  const connectedAccounts = snapshot.accounts.filter((item) => item.connected)
  const providerModels = snapshot.models.filter(
    (item) => item.provider === modelSelection.stagedProvider
  )
  const providerIsStaged = modelSelection.stagedProvider !== snapshot.activeProvider
  const modelWillCreateSession = sessionHasTranscript(snapshot)
  const canCompose = Boolean(
    snapshot.project &&
    snapshot.modelAvailability === 'available' &&
    snapshot.composeBlockReason === null &&
    !providerIsStaged
  )

  useEffect(() => {
    dispatchModelSelection({
      type: 'snapshot:sync',
      generation: snapshot.generation,
      sessionId: snapshot.sessionId,
      activeProvider: snapshot.activeProvider
    })
  }, [snapshot.activeProvider, snapshot.generation, snapshot.sessionId])

  useEffect(() => {
    const input = textarea.current
    if (!input) return
    input.style.height = '0px'
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`
  }, [draft])

  const submit = (): void => {
    if (snapshot.busy && !draft.trim()) {
      onAbort()
      return
    }
    if (!canCompose) {
      onOpenSettings()
      return
    }
    if (!draft.trim()) return
    onSend(draft.trim())
    setDraft('')
  }

  const lockLabel = providerIsStaged
    ? '为暂存账号选择模型'
    : snapshot.composeBlockReason === 'project-required'
      ? '先选择一个工作区'
      : snapshot.composeBlockReason === 'login-required'
        ? '登录 Codex'
        : snapshot.composeBlockReason === 'pinned-model-unavailable'
          ? '此会话钉定的模型当前不可用 · 前往设置'
          : snapshot.composeBlockReason === 'model-unavailable'
            ? '所选模型当前不可用 · 前往设置'
            : '选择模型后才能发送'
  const lockAction = providerIsStaged
    ? undefined
    : snapshot.composeBlockReason === 'login-required'
      ? onLogin
      : snapshot.project
        ? onOpenSettings
        : undefined

  return (
    <div className="composer-wrap">
      <div className={`composer${canCompose ? '' : ' is-locked'}`}>
        {!canCompose && lockAction ? (
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
        <textarea
          ref={textarea}
          className="composer-input"
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={snapshot.busy ? '输入可排队到当前任务之后…' : '给 Pi 下达任务…'}
          aria-label="给 Pi 的任务"
          disabled={!canCompose}
        />
        <div className="composer-tools">
          <button
            className="tool-chip icon-only"
            type="button"
            title="添加附件（即将支持）"
            disabled
          >
            <Plus size={16} />
          </button>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              className="tool-chip permission-chip"
              disabled={!snapshot.project}
            >
              <span className={`permission-dot is-${snapshot.permissionMode}`} />
              <span className="chip-label">
                {snapshot.permissionMode === 'ask' ? 'Ask' : 'Open'}（本次运行）
              </span>
              <ChevronDown size={12} />
            </DropdownMenu.Trigger>
            <MenuContent>
              <DropdownMenu.Label className="dropdown-label">工具权限</DropdownMenu.Label>
              <DropdownMenu.Item
                className="dropdown-item"
                onSelect={() => onPermissionChange('ask')}
              >
                <span>
                  <strong>Ask</strong>
                  <small>本次运行写文件和命令需要确认</small>
                </span>
                {snapshot.permissionMode === 'ask' ? <Check size={14} /> : null}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="dropdown-item"
                onSelect={() => onPermissionChange('open')}
              >
                <span>
                  <strong>Open</strong>
                  <small>本次运行允许 Pi 直接使用工具</small>
                </span>
                {snapshot.permissionMode === 'open' ? <Check size={14} /> : null}
              </DropdownMenu.Item>
            </MenuContent>
          </DropdownMenu.Root>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger className="tool-chip account-chip" disabled={!snapshot.project}>
              <Bot size={14} />
              <span>
                {stagedAccount?.name.replace('OpenAI ', '') ?? '账号'}
                {providerIsStaged ? ' · 待选模型' : ''}
              </span>
              <ChevronDown size={12} />
            </DropdownMenu.Trigger>
            <MenuContent>
              <DropdownMenu.Label className="dropdown-label">账号</DropdownMenu.Label>
              {connectedAccounts.map((item) => (
                <DropdownMenu.Item
                  className="dropdown-item"
                  key={item.id}
                  onSelect={() =>
                    dispatchModelSelection({ type: 'provider:stage', providerId: item.id })
                  }
                >
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.alias ? item.id : '主账号'}
                      {item.id === modelSelection.stagedProvider ? ' · 已暂存' : ''}
                    </small>
                  </span>
                  {item.id === modelSelection.stagedProvider ? <Check size={14} /> : null}
                </DropdownMenu.Item>
              ))}
              {connectedAccounts.length ? (
                <DropdownMenu.Separator className="dropdown-separator" />
              ) : null}
              <DropdownMenu.Item className="dropdown-item compact" onSelect={onLogin}>
                登录 Codex
              </DropdownMenu.Item>
              <DropdownMenu.Item className="dropdown-item compact" onSelect={onOpenSettings}>
                <Settings2 size={14} /> 管理账号
              </DropdownMenu.Item>
            </MenuContent>
          </DropdownMenu.Root>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              className={`tool-chip model-chip${providerIsStaged ? ' is-staged' : ''}`}
              disabled={!stagedAccount?.connected}
            >
              <span>{providerIsStaged ? '选择模型' : (activeModel?.name ?? '选择模型')}</span>
              <ChevronDown size={12} />
            </DropdownMenu.Trigger>
            <MenuContent>
              <DropdownMenu.Label className="dropdown-label">
                {stagedAccount?.name ?? '选择账号后选模型'}
              </DropdownMenu.Label>
              {providerModels.map((item) => (
                <DropdownMenu.Item
                  className="dropdown-item"
                  key={item.id}
                  onSelect={() => onChooseModel(item.provider, item.id)}
                >
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {modelWillCreateSession ? '用此模型新建会话 · ' : ''}
                      {formatTokens(item.contextWindow)} context
                    </small>
                  </span>
                  {item.provider === snapshot.activeProvider &&
                  item.id === snapshot.activeModel &&
                  !providerIsStaged ? (
                    <Check size={14} />
                  ) : null}
                </DropdownMenu.Item>
              ))}
              {providerModels.length === 0 ? (
                <DropdownMenu.Item className="dropdown-item" disabled>
                  此账号暂无可用模型
                </DropdownMenu.Item>
              ) : null}
              <DropdownMenu.Separator className="dropdown-separator" />
              <DropdownMenu.Item className="dropdown-item compact" onSelect={onOpenSettings}>
                <Settings2 size={14} /> 管理账号与模型
              </DropdownMenu.Item>
            </MenuContent>
          </DropdownMenu.Root>

          <span className="composer-spacer" />
          <ContextMeter metrics={snapshot.metrics} />
          <QueuePopover followUp={snapshot.followUp} onClear={onClearQueue} />
          <button
            className={`send${snapshot.busy && !draft.trim() ? ' is-busy' : ''}`}
            type="button"
            title={
              snapshot.busy && !draft.trim()
                ? '停止当前运行'
                : snapshot.busy
                  ? '加入发送队列'
                  : '发送任务'
            }
            aria-label={
              snapshot.busy && !draft.trim()
                ? '停止当前运行'
                : snapshot.busy
                  ? '加入发送队列'
                  : '发送任务'
            }
            onClick={submit}
            disabled={!snapshot.busy && (!canCompose || !draft.trim())}
          >
            {snapshot.busy && !draft.trim() ? (
              <Square size={12} fill="currentColor" />
            ) : snapshot.busy ? (
              <ListPlus size={16} />
            ) : (
              <ArrowUp size={17} />
            )}
          </button>
        </div>
      </div>
      <Stats metrics={snapshot.metrics} />
    </div>
  )
}

export default function Conversation(props: ConversationProps): React.JSX.Element {
  const { snapshot, approvals, loading, error, onApproval, onChooseProject } = props
  const hasNodes = snapshot.nodes.length > 0
  const sessionHeader = activeSessionHeader(
    snapshot.activeSessionPath,
    snapshot.sessions,
    snapshot.status
  )
  const scrollEnd = useRef<HTMLDivElement>(null)
  const streamKey = useMemo(
    () =>
      snapshot.nodes.map((node) => ('markdown' in node ? node.markdown.length : node.id)).join(':'),
    [snapshot.nodes]
  )

  useEffect(() => {
    if (!snapshot.busy) return undefined
    const frame = window.requestAnimationFrame(() => {
      scrollEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [snapshot.busy, streamKey])

  return (
    <main className={`conversation${hasNodes ? ' has-session' : ''}`}>
      {snapshot.project ? (
        <header className="conversation-head">
          <span className="conversation-session-title">{sessionHeader.title}</span>
          <span className="conversation-head-meta">
            <small>
              {snapshot.activeProvider ?? '未选择账号'} / {snapshot.activeModel ?? '未选择模型'}
            </small>
            <span className={`conversation-status is-${sessionHeader.status.tone}`}>
              <i
                className={`session-status-dot is-${sessionHeader.status.tone}`}
                aria-hidden="true"
              />
              {sessionHeader.status.label}
            </span>
            <span className={`runtime-permission is-${snapshot.permissionMode}`}>
              {snapshot.permissionMode === 'ask' ? 'Ask' : 'Open'}（本次运行）
            </span>
          </span>
        </header>
      ) : null}

      <div className="conversation-scroll">
        <div className="content-axis">
          {!hasNodes ? (
            <div className="hero-copy">
              <h1>{snapshot.project ? '从一句指令开始。' : '让项目在这里开口。'}</h1>
              <p>
                {loading
                  ? '正在连接本机 Pi 引擎…'
                  : snapshot.project
                    ? '对话在中，证据在右。会话与 Pi CLI 共用同一份记录。'
                    : '选择一个文件夹作为 Pi 的工作目录。'}
              </p>
              {!snapshot.project ? (
                <button className="hero-project-cta" type="button" onClick={onChooseProject}>
                  <FolderOpen size={16} />
                  选择工作区
                </button>
              ) : null}
            </div>
          ) : (
            <NodeFlow nodes={snapshot.nodes} approvals={approvals} onApproval={onApproval} />
          )}
          {error ? (
            <div className="client-error">
              <CircleAlert size={15} />
              {error}
            </div>
          ) : null}
          <div ref={scrollEnd} />
        </div>
      </div>

      <div className="composer-axis">
        <Composer {...props} />
      </div>
    </main>
  )
}
