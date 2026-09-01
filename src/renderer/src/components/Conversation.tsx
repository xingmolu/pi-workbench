import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import * as Collapsible from '@radix-ui/react-collapsible'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
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
  ModelSummary,
  PermissionMode,
  ToolIntent,
  UsageMetrics
} from '../../../shared/contracts'

type ConversationProps = {
  snapshot: AgentSnapshot
  approval: ApprovalRequest | null
  loading: boolean
  error?: string | null
  onSend: (text: string) => void
  onAbort: () => void
  onPermissionChange: (permission: PermissionMode) => void
  onChooseAccount: (providerId: string, modelId: string) => void
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

function formatTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}K`
  return `${(value / 1_000_000).toFixed(1)}M`
}

function formatDuration(value: number): string {
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`
}

function Stats({ metrics }: { metrics: UsageMetrics }): React.JSX.Element | null {
  if (!metrics.turns && !metrics.input && !metrics.output) return null
  const groups: string[] = [`${metrics.turns}轮 · ${metrics.steps}步`]
  if (metrics.llmDurationMs !== undefined)
    groups.push(`LLM ${formatDuration(metrics.llmDurationMs)}`)
  if (metrics.firstTokenMs !== undefined) {
    const speed =
      metrics.tokensPerSecond !== undefined ? ` · ${metrics.tokensPerSecond.toFixed(0)} tok/s` : ''
    groups.push(`首 token ${formatDuration(metrics.firstTokenMs)}${speed}`)
  }
  if (metrics.input + metrics.cacheRead > 0) {
    const hit = (metrics.cacheRead / (metrics.input + metrics.cacheRead)) * 100
    groups.push(`缓存命中 ${hit.toFixed(0)}%`)
  }
  groups.push(`输入 ${formatTokens(metrics.input)} tok · 输出 ${formatTokens(metrics.output)} tok`)
  return <div className="composer-stats">{groups.join('  |  ')}</div>
}

function Markdown({ children }: { children: string }): React.JSX.Element {
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
}

function ThinkNode({
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
}

function ToolNode({
  node,
  approval,
  onApproval
}: {
  node: Extract<ConversationNode, { type: 'tool' }>
  approval: ApprovalRequest | null
  onApproval: (id: string, allow: boolean) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const Icon = TOOL_ICON[node.intent]
  const activeApproval = approval?.toolCallId === node.toolCallId ? approval : null
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
}

function NodeFlow({
  nodes,
  approval,
  onApproval
}: {
  nodes: ConversationNode[]
  approval: ApprovalRequest | null
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
          return (
            <article
              className={`assistant-node${node.streaming ? ' is-streaming' : ''}`}
              key={node.id}
            >
              <Markdown>{node.markdown}</Markdown>
            </article>
          )
        }
        if (node.type === 'think') return <ThinkNode key={node.id} node={node} />
        if (node.type === 'tool') {
          return <ToolNode key={node.id} node={node} approval={approval} onApproval={onApproval} />
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

function firstModel(models: ModelSummary[], providerId: string): ModelSummary | undefined {
  return models.find((model) => model.provider === providerId)
}

function Composer({
  snapshot,
  onSend,
  onAbort,
  onPermissionChange,
  onChooseAccount,
  onChooseModel,
  onLogin,
  onOpenSettings
}: Pick<
  ConversationProps,
  | 'snapshot'
  | 'onSend'
  | 'onAbort'
  | 'onPermissionChange'
  | 'onChooseAccount'
  | 'onChooseModel'
  | 'onLogin'
  | 'onOpenSettings'
>): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const account = snapshot.accounts.find((item) => item.id === snapshot.activeProvider)
  const model = snapshot.models.find(
    (item) => item.provider === snapshot.activeProvider && item.id === snapshot.activeModel
  )
  const connectedAccounts = snapshot.accounts.filter((item) => item.connected)
  const providerModels = snapshot.models.filter((item) => item.provider === snapshot.activeProvider)
  const canCompose = Boolean(snapshot.project && account?.connected && model)
  const contextPercent = Math.max(0, Math.min(100, snapshot.metrics.contextPercent ?? 0))

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

  return (
    <div className="composer-wrap">
      <div className={`composer${canCompose ? '' : ' is-locked'}`}>
        {!canCompose ? (
          <button
            className="composer-lock"
            type="button"
            onClick={snapshot.project ? onOpenSettings : undefined}
          >
            <LockKeyhole size={14} />
            {snapshot.project ? '登录 Codex 并选择模型后才能发送' : '先选择一个工作区'}
          </button>
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
            <DropdownMenu.Trigger className="tool-chip permission-chip">
              <span className={`permission-dot is-${snapshot.permissionMode}`} />
              {snapshot.permissionMode === 'ask' ? 'Ask' : 'Open'}
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
                  <small>写文件和命令需要确认</small>
                </span>
                {snapshot.permissionMode === 'ask' ? <Check size={14} /> : null}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="dropdown-item"
                onSelect={() => onPermissionChange('open')}
              >
                <span>
                  <strong>Open</strong>
                  <small>允许 Pi 直接使用工具</small>
                </span>
                {snapshot.permissionMode === 'open' ? <Check size={14} /> : null}
              </DropdownMenu.Item>
            </MenuContent>
          </DropdownMenu.Root>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger className="tool-chip account-chip">
              <Bot size={14} />
              <span>{account?.name.replace('OpenAI ', '') ?? '账号'}</span>
              <ChevronDown size={12} />
            </DropdownMenu.Trigger>
            <MenuContent>
              <DropdownMenu.Label className="dropdown-label">账号</DropdownMenu.Label>
              {connectedAccounts.map((item) => {
                const nextModel = firstModel(snapshot.models, item.id)
                return (
                  <DropdownMenu.Item
                    className="dropdown-item"
                    key={item.id}
                    disabled={!nextModel}
                    onSelect={() => nextModel && onChooseAccount(item.id, nextModel.id)}
                  >
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.alias ? item.id : '主账号'}</small>
                    </span>
                    {item.id === snapshot.activeProvider ? <Check size={14} /> : null}
                  </DropdownMenu.Item>
                )
              })}
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
            <DropdownMenu.Trigger className="tool-chip model-chip" disabled={!account?.connected}>
              <span>{model?.name ?? '模型'}</span>
              <ChevronDown size={12} />
            </DropdownMenu.Trigger>
            <MenuContent>
              <DropdownMenu.Label className="dropdown-label">
                {account?.name ?? '选择账号后选模型'}
              </DropdownMenu.Label>
              {providerModels.map((item) => (
                <DropdownMenu.Item
                  className="dropdown-item"
                  key={item.id}
                  onSelect={() => onChooseModel(item.provider, item.id)}
                >
                  <span>
                    <strong>{item.name}</strong>
                    <small>{formatTokens(item.contextWindow)} context</small>
                  </span>
                  {item.id === snapshot.activeModel ? <Check size={14} /> : null}
                </DropdownMenu.Item>
              ))}
            </MenuContent>
          </DropdownMenu.Root>

          <span className="composer-spacer" />
          <span
            className="context-meter"
            style={{ '--context-angle': `${contextPercent * 3.6}deg` } as CSSProperties}
            title={
              snapshot.metrics.contextTokens !== undefined && snapshot.metrics.contextWindow
                ? `上下文 ${formatTokens(snapshot.metrics.contextTokens)} / ${formatTokens(snapshot.metrics.contextWindow)}`
                : '上下文用量未知'
            }
            aria-label={`上下文已用 ${contextPercent.toFixed(0)}%`}
          />
          {snapshot.queuedCount ? (
            <span className="queue-count">{snapshot.queuedCount}</span>
          ) : null}
          <button
            className={`send${snapshot.busy && !draft.trim() ? ' is-busy' : ''}`}
            type="button"
            title={snapshot.busy && !draft.trim() ? '停止' : snapshot.busy ? '加入队列' : '发送'}
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
  const { snapshot, approval, loading, error, onApproval } = props
  const hasNodes = snapshot.nodes.length > 0
  const scrollEnd = useRef<HTMLDivElement>(null)
  const streamKey = useMemo(
    () =>
      snapshot.nodes.map((node) => ('markdown' in node ? node.markdown.length : node.id)).join(':'),
    [snapshot.nodes]
  )

  useEffect(() => {
    if (snapshot.busy) scrollEnd.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [snapshot.busy, streamKey])

  return (
    <main className={`conversation${hasNodes ? ' has-session' : ''}`}>
      {snapshot.project && hasNodes ? (
        <header className="conversation-head">
          <span>{snapshot.project.name}</span>
          <small>{snapshot.activeModel ?? '未选择模型'}</small>
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
                <span className="hero-project-hint">
                  <FolderOpen size={15} /> 从左侧选择工作区
                </span>
              ) : null}
            </div>
          ) : (
            <NodeFlow nodes={snapshot.nodes} approval={approval} onApproval={onApproval} />
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
