export const AGENT_ENGINE = '@earendil-works/pi-coding-agent' as const

export type PermissionMode = 'open' | 'ask'

export type ToolIntent = 'terminal' | 'read' | 'diff' | 'search' | 'web' | 'generic'

export type ToolStatus =
  'queued' | 'awaiting-approval' | 'running' | 'success' | 'error' | 'blocked'

export type SessionStatus = 'idle' | 'running' | 'awaiting-approval' | 'error'

export type ConversationNode =
  | {
      id: string
      type: 'user'
      text: string
    }
  | {
      id: string
      type: 'assistant'
      markdown: string
      streaming?: boolean
    }
  | {
      id: string
      type: 'think'
      text: string
      streaming?: boolean
    }
  | {
      id: string
      type: 'tool'
      toolCallId: string
      name: string
      intent: ToolIntent
      title: string
      detail?: string
      output?: string
      durationMs?: number
      originalOutputLength?: number
      truncated?: boolean
      status: ToolStatus
    }
  | {
      id: string
      type: 'error'
      message: string
    }

export type ProjectInfo = {
  path: string
  name: string
}

export type SessionSummary = {
  id: string
  path: string
  title: string
  modified: string
  messageCount: number
  active: boolean
  status: SessionStatus
}

export type AccountSummary = {
  id: string
  name: string
  authType: 'api_key' | 'oauth'
  connected: boolean
  subscription: boolean
  alias: boolean
}

export type ModelSummary = {
  provider: string
  id: string
  name: string
  contextWindow: number
  reasoning: boolean
}

export type ModelAvailability = 'available' | 'unavailable' | 'unselected'

export type ComposeBlockReason =
  | 'project-required'
  | 'login-required'
  | 'model-required'
  | 'model-unavailable'
  | 'pinned-model-unavailable'
  | null

export type UsageMetrics = {
  turns: number
  steps: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  contextTokens?: number
  contextWindow?: number
  contextPercent?: number
  llmDurationMs?: number
  firstTokenMs?: number
  tokensPerSecond?: number
}

export type ApprovalRequest = {
  id: string
  generation: number
  toolCallId: string
  toolName: string
  intent: ToolIntent
  title: string
  detail: string
}

export type LoginMethod = 'browser' | 'device_code'

export type LoginPrompt = {
  id: string
  providerId: string
  type: 'text' | 'secret' | 'select' | 'manual_code'
  message: string
  placeholder?: string
  options?: { id: string; label: string; description?: string }[]
}

export type LoginStatus =
  | { phase: 'idle' }
  | { phase: 'starting'; providerId: string }
  | {
      phase: 'browser'
      providerId: string
      url: string
      instructions?: string
    }
  | {
      phase: 'device_code'
      providerId: string
      userCode: string
      verificationUri: string
      expiresInSeconds?: number
    }
  | { phase: 'waiting'; providerId: string; message: string }
  | { phase: 'success'; providerId: string }
  | { phase: 'error'; providerId: string; message: string }

export type AgentSnapshot = {
  sessionId: string | null
  generation: number
  revision: number
  ready: boolean
  engine: typeof AGENT_ENGINE
  agentDir: string
  project: ProjectInfo | null
  sessions: SessionSummary[]
  activeSessionPath: string | null
  nodes: ConversationNode[]
  accounts: AccountSummary[]
  models: ModelSummary[]
  activeProvider: string | null
  activeModel: string | null
  modelAvailability: ModelAvailability
  composeBlockReason: ComposeBlockReason
  busy: boolean
  status: SessionStatus
  approvals: ApprovalRequest[]
  followUp: string[]
  queuedCount: number
  permissionMode: PermissionMode
  metrics: UsageMetrics
  login: LoginStatus
  loginPrompt: LoginPrompt | null
  error?: string
}

export type AgentSnapshotMeta = Omit<
  AgentSnapshot,
  'sessionId' | 'generation' | 'revision' | 'nodes'
>

export type AgentStatePatch = {
  sessionId: string | null
  generation: number
  baseRevision: number
  revision: number
  nodeUpserts: ConversationNode[]
  removedNodeIds: string[]
  nodeOrder?: string[]
  meta: Partial<AgentSnapshotMeta>
}

export type SessionNewCommand =
  { type: 'session:new' } | { type: 'session:new'; providerId: string; modelId: string }

export type HostCommand =
  | { type: 'bootstrap' }
  | { type: 'state:get' }
  | { type: 'project:open'; cwd: string }
  | SessionNewCommand
  | { type: 'session:open'; path: string }
  | { type: 'prompt:send'; text: string }
  | { type: 'prompt:abort' }
  | { type: 'queue:clear' }
  | { type: 'permission:set'; mode: PermissionMode }
  | { type: 'permission:respond'; approvalId: string; allow: boolean }
  | { type: 'account:login'; providerId: string; method: LoginMethod }
  | { type: 'account:login:respond'; promptId: string; value?: string }
  | { type: 'account:alias:add'; slug: string }
  | { type: 'model:set'; providerId: string; modelId: string }

export type HostRequest = HostCommand & { requestId: string }

export type SnapshotHostCommand = Extract<
  HostCommand,
  { type: 'bootstrap' | 'state:get' | 'project:open' | 'session:new' | 'session:open' }
>
export type AckHostCommand = Exclude<HostCommand, SnapshotHostCommand>

export type HostSnapshotResult = { kind: 'snapshot'; snapshot: AgentSnapshot }
export type HostAckResult = {
  kind: 'ack'
  sessionId: string | null
  generation: number
  revision: number
}
export type HostResult = HostSnapshotResult | HostAckResult
export type HostResultFor<Command extends HostCommand> = Command extends SnapshotHostCommand
  ? HostSnapshotResult
  : HostAckResult

export type HostResponse =
  | {
      type: 'response'
      requestId: string
      ok: true
      data: HostResult
    }
  | {
      type: 'response'
      requestId: string
      ok: false
      error: string
    }

export type HostEvent =
  | { type: 'event'; event: 'snapshot'; data: AgentSnapshot }
  | { type: 'event'; event: 'patch'; data: AgentStatePatch }
  | { type: 'event'; event: 'open-external'; data: { url: string } }

export type HostMessage = HostResponse | HostEvent

export type PiDesktopAPI = {
  getState: () => Promise<AgentSnapshot>
  selectProject: () => Promise<AgentSnapshot | null>
  send: <Command extends HostCommand>(command: Command) => Promise<HostResultFor<Command>>
  onEvent: (listener: (event: HostEvent) => void) => () => void
}
