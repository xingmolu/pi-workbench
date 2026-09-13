export * from './workbench-contracts'
import type { MessageFeedbackCommand, MessageFeedbackValue } from './message-actions'
import type { ProjectCatalog, ProjectCatalogCommand, ProjectNavigateCommand } from './project-catalog'
import type { SessionEditCommand, SessionEditResult } from './session-edit'
import type {
  AttachmentCommand,
  AttachmentResult,
  AttachmentHostCommand,
  AttachmentReceipt
} from './text-attachments'
import type {
  CustomEndpointConfigSnapshot,
  CustomEndpointContext,
  CustomEndpointSaveRequest,
  CustomEndpointSaveResult
} from './custom-endpoints'
import type { WorkspaceFilesCommand, WorkspaceFilesResult } from './workspace-files'
import type { TerminalCommand, TerminalEvent, TerminalResult } from './terminal'
import type { GitReviewCommand, GitReviewResult } from './git-review'
import type {
  WorkbenchCommand,
  WorkbenchCommandResult,
  WorkbenchEvent
} from './workbench-contracts'

export const AGENT_ENGINE = '@earendil-works/pi-coding-agent' as const

export type PermissionMode = 'open' | 'ask'

export type ToolIntent = 'terminal' | 'read' | 'diff' | 'search' | 'web' | 'generic'

export type ToolStatus =
  'queued' | 'awaiting-approval' | 'running' | 'success' | 'error' | 'blocked'

export type SessionStatus = 'idle' | 'running' | 'awaiting-approval' | 'error' | 'stopped'

export type ConversationNode = {
  /** Host-only display continuity within one runtime generation; never a command target. */
  presentationIdentity?: string
} & (
  | {
      id: string
      type: 'model'
      provider: string
      modelId: string
      name?: string
      initial: boolean
    }
  | { id: string; type: 'compaction'; tokensBefore: number }
  | {
      id: string
      type: 'user'
      text: string
      canonicalEntryId?: string
      imageCount?: number
    }
  | {
      id: string
      type: 'assistant'
      markdown: string
      streaming?: boolean
      canonicalEntryId?: string
      feedback?: MessageFeedbackValue
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
  | { id: string; type: 'stopped'; message: string }
)

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
  parentSessionPath?: string
  parentUnavailable?: boolean
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
  unavailableReason?: string
}

export type ModelAvailability = 'available' | 'unavailable' | 'unselected'

export type ComposeBlockReason =
  | 'project-required'
  | 'login-required'
  | 'model-required'
  | 'model-unavailable'
  | 'pinned-model-unavailable'
  | 'endpoint-runtime-unsynchronized'
  | 'endpoint-selection-invalidated'
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
  usageIncomplete?: boolean
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

export type BrowserBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserPageSummary = {
  id: string
  title: string
  url: string
  active: boolean
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export type BrowserState = {
  available: boolean
  visible: boolean
  pages: BrowserPageSummary[]
  activePageId: string | null
  controller: 'idle' | 'user' | 'agent'
  lastAction?: string
  error?: string
}

export type BrowserOperation =
  | { action: 'tabs' }
  | { action: 'new_tab'; url?: string }
  | { action: 'select_tab'; pageId: string }
  | { action: 'close_tab'; pageId: string }
  | { action: 'navigate'; url: string; pageId?: string }
  | { action: 'back' | 'forward' | 'reload' | 'snapshot' | 'screenshot'; pageId?: string }
  | { action: 'click'; ref: string; pageId?: string }
  | { action: 'fill' | 'select'; ref: string; value: string; pageId?: string }
  | { action: 'keypress'; key: string; pageId?: string }
  | {
      action: 'scroll'
      direction: 'up' | 'down' | 'left' | 'right'
      amount?: number
      pageId?: string
    }
  | { action: 'wait'; text?: string; url?: string; timeoutMs?: number; pageId?: string }

export type BrowserSnapshotResult = {
  kind: 'snapshot'
  pageId: string
  pageRevision: number
  url: string
  title: string
  text: string
}

export type BrowserScreenshotResult = {
  kind: 'screenshot'
  pageId: string
  url: string
  mimeType: 'image/png'
  data: string
}

export type BrowserActionResult = {
  kind: 'action'
  pageId: string
  pageRevision: number
  url: string
  message: string
}

export type BrowserOperationResult =
  | { kind: 'state'; state: BrowserState }
  | BrowserSnapshotResult
  | BrowserScreenshotResult
  | BrowserActionResult

export type BrowserCommand =
  | { type: 'state:get' }
  | { type: 'operate'; operation: BrowserOperation }
  | { type: 'agent:stop' }
  | { type: 'e2e:agent'; operation: BrowserOperation }

export type BrowserCommandResult = {
  state: BrowserState
  result?: BrowserOperationResult
}

export type BrowserEvent = { type: 'state'; data: BrowserState }

export type BrowserCapabilityRequest = {
  type: 'capability-request'
  capability: 'browser'
  requestId: string
  sessionId: string | null
  generation: number
  operation: BrowserOperation
}

export type BrowserCapabilityCancel = {
  type: 'capability-cancel'
  capability: 'browser'
  requestId: string
}

export type BrowserCapabilityResponse =
  | {
      type: 'capability-response'
      capability: 'browser'
      requestId: string
      ok: true
      data: BrowserOperationResult
    }
  | {
      type: 'capability-response'
      capability: 'browser'
      requestId: string
      ok: false
      error: string
    }

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
  fork?: { entryId: string | null; reason: string | null }
  edit?: { entryId: string | null; leafId: string | null; reason: string | null; pending: boolean }
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
  authGeneration?: number
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
  | import('./skills').SkillsCommand
  | import('./mcp').McpCommand
  | MessageFeedbackCommand
  | ProjectCatalogCommand
  | ProjectNavigateCommand
  | SessionEditCommand
  | AttachmentHostCommand
  | { type: 'bootstrap' }
  | { type: 'state:get' }
  | { type: 'project:open'; cwd: string }
  | SessionNewCommand
  | { type: 'session:open'; path: string }
  | { type: 'session:fork'; sessionId: string; generation: number; entryId: string }
  | { type: 'session:rename'; sessionId: string; generation: number; name: string }
  | { type: 'prompt:send'; text: string; sessionId: string; generation: number }
  | { type: 'prompt:abort' }
  | { type: 'queue:clear' }
  | { type: 'permission:set'; mode: PermissionMode }
  | { type: 'permission:respond'; approvalId: string; allow: boolean }
  | { type: 'account:login'; providerId: string; method: LoginMethod }
  | { type: 'account:quota'; providerId: string }
  | { type: 'account:login:respond'; promptId: string; value?: string }
  | { type: 'account:alias:add'; slug: string }
  | { type: 'model:set'; providerId: string; modelId: string }
  | { type: 'endpoint:list' }
  | { type: 'endpoint:save'; context: CustomEndpointContext; request: CustomEndpointSaveRequest }
  | { type: 'browser:e2e'; operation: BrowserOperation }

export type HostRequest = HostCommand & { requestId: string }

export type SnapshotHostCommand = Extract<
  HostCommand,
  { type: 'bootstrap' | 'state:get' | 'project:open' | 'project:navigate' | 'session:new' | 'session:open' }
>
export type EndpointHostCommand = Extract<HostCommand, { type: 'endpoint:list' | 'endpoint:save' }>
export type AckHostCommand = Exclude<
  HostCommand,
  | SnapshotHostCommand
  | EndpointHostCommand
  | Extract<HostCommand, { type: 'session:fork' }>
  | AttachmentHostCommand
  | SessionEditCommand
  | ProjectCatalogCommand
  | Extract<HostCommand, { type: 'account:quota' }>
  | import('./mcp').McpCommand
  | import('./skills').SkillsCommand
>

export type HostSnapshotResult = { kind: 'snapshot'; snapshot: AgentSnapshot }
export type HostAckResult = {
  kind: 'ack'
  sessionId: string | null
  generation: number
  revision: number
}
export type HostEndpointListResult = {
  kind: 'endpoint-list'
  snapshot: CustomEndpointConfigSnapshot
  configPath: string
}
export type HostEndpointSaveResult = { kind: 'endpoint-save'; result: CustomEndpointSaveResult }
export type HostResult =
  | { kind: 'skills-list'; catalog: import('./skills').SkillsCatalogSnapshot }
  | { kind: 'skills-detail'; detail: import('./skills').SkillDetail }
  | { kind: 'mcp'; result: import('./mcp').McpSnapshot }
  | { kind: 'account-quota'; quota: import('./account-quota').AccountQuota }
  | { kind: 'project-catalog'; catalog: ProjectCatalog }
  | { kind: 'session-edit'; result: SessionEditResult }
  | { kind: 'session-fork'; cancelled: boolean; snapshot: AgentSnapshot }
  | HostSnapshotResult
  | HostAckResult
  | HostEndpointListResult
  | HostEndpointSaveResult
  | { kind: 'attachment'; receipt: AttachmentReceipt }
export type HostResultFor<Command extends HostCommand> = Command extends { type: 'skills:list' }
  ? { kind: 'skills-list'; catalog: import('./skills').SkillsCatalogSnapshot }
  : Command extends { type: 'skills:detail' }
  ? { kind: 'skills-detail'; detail: import('./skills').SkillDetail }
  : Command extends import('./mcp').McpCommand
  ? { kind: 'mcp'; result: import('./mcp').McpSnapshot }
  : Command extends { type: 'account:quota' }
  ? { kind: 'account-quota'; quota: import('./account-quota').AccountQuota }
  : Command extends ProjectCatalogCommand
  ? { kind: 'project-catalog'; catalog: ProjectCatalog }
  : Command extends SessionEditCommand
  ? { kind: 'session-edit'; result: SessionEditResult }
  : Command extends { type: 'session:fork' }
    ? { kind: 'session-fork'; cancelled: boolean; snapshot: AgentSnapshot }
    : Command extends SnapshotHostCommand
      ? HostSnapshotResult
      : Command extends AttachmentHostCommand
        ? { kind: 'attachment'; receipt: AttachmentReceipt }
        : Command extends { type: 'endpoint:list' }
          ? HostEndpointListResult
          : Command extends { type: 'endpoint:save' }
            ? HostEndpointSaveResult
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

export type DesktopEvent =
  | HostEvent
  | {
      type: 'event'
      event: 'disconnected'
      data: { message: string }
    }

export type PiDesktopAPI = {
  exportMarkdownTable: (
    request: import('./markdown-table-export').MarkdownTableRequest
  ) => Promise<import('./markdown-table-export').MarkdownTableResult>
  textAttachments: (command: AttachmentCommand) => Promise<AttachmentResult>
  terminal: (command: TerminalCommand) => Promise<TerminalResult>
  onTerminalEvent: (listener: (event: TerminalEvent) => void) => () => void
  gitReview: (command: GitReviewCommand) => Promise<GitReviewResult>
  workspaceFiles: (command: WorkspaceFilesCommand) => Promise<WorkspaceFilesResult>
  getState: () => Promise<AgentSnapshot>
  reconnect: () => Promise<AgentSnapshot>
  selectProject: () => Promise<AgentSnapshot | null>
  send: <Command extends HostCommand>(command: Command) => Promise<HostResultFor<Command>>
  onEvent: (listener: (event: DesktopEvent) => void) => () => void
  browser: (command: BrowserCommand) => Promise<BrowserCommandResult>
  onBrowserEvent: (listener: (event: BrowserEvent) => void) => () => void
  workbench: (command: WorkbenchCommand) => Promise<WorkbenchCommandResult>
  onWorkbenchEvent: (listener: (event: WorkbenchEvent) => void) => () => void
}
