export const AGENT_ENGINE = '@earendil-works/pi-coding-agent' as const

export type PermissionMode = 'open' | 'ask'

export type ToolIntent = 'terminal' | 'read' | 'diff' | 'search' | 'web' | 'generic'

export type ToolStatus =
  'queued' | 'awaiting-approval' | 'running' | 'success' | 'error' | 'blocked'

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
  busy: boolean
  queuedCount: number
  permissionMode: PermissionMode
  metrics: UsageMetrics
  login: LoginStatus
  error?: string
}

export type HostCommand =
  | { type: 'bootstrap' }
  | { type: 'state:get' }
  | { type: 'project:open'; cwd: string }
  | { type: 'session:new'; providerId?: string; modelId?: string }
  | { type: 'session:open'; path: string }
  | { type: 'prompt:send'; text: string }
  | { type: 'prompt:abort' }
  | { type: 'permission:set'; mode: PermissionMode }
  | { type: 'permission:respond'; requestId: string; allow: boolean }
  | { type: 'account:login'; providerId: string; method: LoginMethod }
  | { type: 'account:login:respond'; promptId: string; value?: string }
  | { type: 'account:alias:add'; slug: string }
  | { type: 'model:set'; providerId: string; modelId: string }

export type HostRequest = HostCommand & { requestId: string }

export type HostResponse = {
  type: 'response'
  requestId: string
  ok: boolean
  data?: unknown
  error?: string
}

export type HostEvent =
  | { type: 'event'; event: 'state'; data: AgentSnapshot }
  | { type: 'event'; event: 'approval'; data: ApprovalRequest }
  | { type: 'event'; event: 'login-prompt'; data: LoginPrompt }
  | { type: 'event'; event: 'open-external'; data: { url: string } }

export type HostMessage = HostResponse | HostEvent

export type PiDesktopAPI = {
  getState: () => Promise<AgentSnapshot>
  selectProject: () => Promise<AgentSnapshot | null>
  send: (command: HostCommand) => Promise<AgentSnapshot>
  onEvent: (listener: (event: HostEvent) => void) => () => void
}
