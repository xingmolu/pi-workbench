export * from './workbench-contracts'
import type { DesktopCommandOrigin, LiveSessionSummary, SelectedSessionScope } from './session-runtime'
import type { MessageFeedbackCommand, MessageFeedbackValue } from './message-actions'
import type {
  CheckpointCommand,
  CheckpointTurnState,
  HostCheckpointResult
} from './checkpoints'
import type { PermissionRules, PermissionRulesCommand } from './permission-rules'
import type { ProjectCatalog, ProjectCatalogCommand, ProjectNavigateCommand } from './project-catalog'
import type { SessionSearchCommand, ProjectSearchCommand, SessionSearchResult, ProjectSearchResult } from './session-search'
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
import type { ComputerUseOperation, ComputerUseResult } from './computer-use'

export const AGENT_ENGINE = '@earendil-works/pi-coding-agent' as const

/** `ask`: request approval; `auto`: approve routine, undoable work and ask for the rest;
 * `open`: full access. */
export type PermissionMode = 'open' | 'auto' | 'ask'

export type ToolIntent = 'terminal' | 'read' | 'diff' | 'search' | 'web' | 'desktop' | 'generic'

export type ToolStatus =
  'queued' | 'awaiting-approval' | 'waiting-resource' | 'running' | 'success' | 'error' | 'blocked' | 'incomplete'

export type SessionStatus = 'idle' | 'running' | 'awaiting-approval' | 'error' | 'stopped'

/** A file mutation requested by, or applied through, a write/edit tool call. */
export type ToolFileChange = {
  path: string
  kind: 'edit' | 'write'
  /** `proposed` comes from the model's arguments; `applied` is the tool's own result patch. */
  source: 'proposed' | 'applied'
  /** Whether hunk line numbers are real file positions. */
  anchored: boolean
  /** Unified patch; empty when `omitted` because it exceeded the display budget. */
  patch: string
  additions: number
  deletions: number
  omitted?: boolean
}

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
      subagent?: import('./subagent').SubagentOperation
      change?: ToolFileChange
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
  runtimeId?: string
  path: string
  title: string
  modified: string
  messageCount: number
  active: boolean
  status: SessionStatus
  parentSessionPath?: string
  parentUnavailable?: boolean
}

/** Subscription platforms an engine can sign in to; each account is one login. */
export type SubscriptionPlatform = 'chatgpt' | 'claude'

export type AccountSummary = {
  id: string
  name: string
  authType: 'api_key' | 'oauth'
  connected: boolean
  subscription: boolean
  alias: boolean
  /** Set for subscription logins; their identity is the email, not an alias name. */
  platform?: SubscriptionPlatform
  email?: string
  /** Plan label as the platform reports it, e.g. Plus, Pro, Max. */
  plan?: string
  /** Host of an API connection's base URL. */
  endpoint?: string
}

export type ModelSummary = {
  provider: string
  id: string
  name: string
  contextWindow: number
  reasoning: boolean
  input?: ('text' | 'image')[]
  unavailableReason?: string
}

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export type PromptImage = {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  data: string
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
  /** Offered as "allow for the rest of this task": Computer Use actions in this app. */
  grant?: { kind: 'computer-app'; app: string; bundleId: string }
}

export type RuntimeAccounts = {
  runtimeId: string
  label: string
  accounts: AccountSummary[]
  login: LoginStatus
  loginPrompt: LoginPrompt | null
  authGeneration: number
  /** The engine could not start (not installed, crashed, unsupported platform). */
  error?: string
  /** Engines whose CLI is downloaded on demand report whether it is here yet. */
  binary?: import('./engine-binaries').EngineBinaryStatus
  /** The engine signs in with accounts another engine holds (Codex uses Pi's ChatGPT logins). */
  borrowsAccounts?: boolean
}
export type RuntimeConfigCommand = Extract<
  HostCommand,
  {
    type:
      | 'account:add'
      | 'account:remove'
      | 'account:login'
      | 'account:login:respond'
      | 'account:api-key:set'
      | 'account:quota'
      | 'endpoint:list'
      | 'endpoint:save'
      | 'endpoint:discover'
  }
>

/** `turn`: also allow what `grant` names until the current task ends. */
export type ApprovalScope = 'once' | 'turn'

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

export type ComputerUseCapabilityRequest = {
  type: 'capability-request'
  capability: 'computer-use'
  requestId: string
  sessionId: string | null
  generation: number
  operation: ComputerUseOperation
}

export type ComputerUseCapabilityCancel = {
  type: 'capability-cancel'
  capability: 'computer-use'
  requestId: string
}

export type ComputerUseCapabilityResponse =
  | {
      type: 'capability-response'
      capability: 'computer-use'
      requestId: string
      ok: true
      data: ComputerUseResult
    }
  | {
      type: 'capability-response'
      capability: 'computer-use'
      requestId: string
      ok: false
      error: string
    }

export type AgentSnapshot = {
  /** Main-only foreground epoch; never persisted in Pi history. */
  desktopScope?: SelectedSessionScope
  /** Monotonic desktop barrier for a deliberately closed workspace (no selected worker). */
  desktopEpoch?: number
  sessionId: string | null
  generation: number
  revision: number
  ready: boolean
  engine: string
  /** Adapter identity/capabilities; separate from the selected language-model provider. */
  runtime?: import('./agent-runtime').AgentRuntimeManifest
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
  /** Reasoning effort of the active model; null when the model does not reason. */
  thinking?: { level: ThinkingLevel; available: ThinkingLevel[] } | null
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
  /** Turns of the current session whose write/edit changes can be (or were) rolled back. */
  checkpoints?: CheckpointTurnState[]
  /** Allow rules of the open project; absent without a project. */
  permissionRules?: PermissionRules
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
  { type: 'session:new'; runtimeId?: string } | { type: 'session:new'; runtimeId?: string; providerId: string; modelId: string }

export type HostCommand =
  | ((SessionSearchCommand | ProjectSearchCommand) & { recentPaths?: string[] })
  | import('./skills').SkillsCommand
  | import('./mcp').McpCommand
  | MessageFeedbackCommand
  | CheckpointCommand
  | PermissionRulesCommand
  | ProjectCatalogCommand
  | ProjectNavigateCommand
  | SessionEditCommand
  | AttachmentHostCommand
  | { type: 'bootstrap' }
  | { type: 'runtime:refresh' }
  | { type: 'runtime:shutdown' }
  | { type: 'state:get'; refreshSessions?: boolean }
  | { type: 'project:open'; cwd: string; runtimeId?: string }
  | SessionNewCommand
  | { type: 'session:open'; path: string }
  | { type: 'session:fork'; sessionId: string; generation: number; entryId: string }
  | { type: 'session:rename'; sessionId: string; generation: number; name: string }
  | {
      type: 'prompt:send'
      text: string
      sessionId: string
      generation: number
      /** Base64 images for models that accept image input (sent from the phone). */
      images?: PromptImage[]
    }
  | { type: 'prompt:abort' }
  | { type: 'session-task:cancel'; taskId: string; sessionId: string; generation: number }
  | { type: 'subagent:inspect'; taskId: string; sessionId: string; generation: number }
  | { type: 'queue:clear' }
  | { type: 'permission:set'; mode: PermissionMode }
  | { type: 'permission:respond'; approvalId: string; allow: boolean; scope?: ApprovalScope }
  | { type: 'account:login'; providerId: string; method: LoginMethod }
  | {
      type: 'account:api-key:set'
      providerId: string
      apiKey: string
      baseUrl?: string
      /** Display name of a new API connection (engines with several connections). */
      label?: string
    }
  | { type: 'account:quota'; providerId: string }
  /** Main-only: a fresh ChatGPT access token for another engine; never routed from a renderer. */
  | { type: 'account:token'; providerId: string }
  | { type: 'account:login:respond'; promptId: string; value?: string }
  | { type: 'account:alias:add'; slug: string }
  | { type: 'account:add'; platform: SubscriptionPlatform; method: LoginMethod }
  | { type: 'account:remove'; providerId: string }
  | { type: 'model:set'; providerId: string; modelId: string }
  | { type: 'thinking:set'; level: ThinkingLevel }
  | import('./custom-endpoints').EndpointDiscoverCommand
  | { type: 'endpoint:list' }
  | { type: 'endpoint:save'; context: CustomEndpointContext; request: CustomEndpointSaveRequest }
  | { type: 'browser:e2e'; operation: BrowserOperation }

export type HostRequest = HostCommand & { requestId: string; expectedIdentity?: { sessionId: string | null; generation: number } }

export type SnapshotHostCommand = Extract<
  HostCommand,
  { type: 'bootstrap' | 'state:get' | 'runtime:refresh' | 'runtime:shutdown' | 'project:open' | 'project:navigate' | 'session:new' | 'session:open' }
>
export type EndpointHostCommand = Extract<HostCommand, { type: 'endpoint:list' | 'endpoint:save' | 'endpoint:discover' }>
export type AckHostCommand = Exclude<
  HostCommand,
  | SnapshotHostCommand
  | EndpointHostCommand
  | Extract<HostCommand, { type: 'session:fork' }>
  | Extract<HostCommand, { type: 'subagent:inspect' }>
  | AttachmentHostCommand
  | SessionEditCommand
  | ProjectCatalogCommand
  | Extract<HostCommand, { type: 'account:quota' | 'account:token' }>
  | CheckpointCommand
  | SessionSearchCommand | ProjectSearchCommand
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
export type HostEndpointDiscoveryResult = { kind: 'endpoint-discovery'; result: import('./custom-endpoints').EndpointDiscovery }
export type HostResult =
  | HostEndpointDiscoveryResult
  | { kind: 'session-search'; result: SessionSearchResult }
  | { kind: 'project-search'; result: ProjectSearchResult }
  | { kind: 'skills-list'; catalog: import('./skills').SkillsCatalogSnapshot }
  | { kind: 'skills-detail'; detail: import('./skills').SkillDetail }
  | { kind: 'mcp'; result: import('./mcp').McpSnapshot }
  | { kind: 'account-quota'; quota: import('./account-quota').AccountQuota }
  | { kind: 'account-token'; token: import('./engine-credentials').ChatgptAccessToken }
  | { kind: 'project-catalog'; catalog: ProjectCatalog }
  | { kind: 'subagent-inspection'; snapshot: AgentSnapshot }
  | { kind: 'session-edit'; result: SessionEditResult }
  | { kind: 'session-fork'; cancelled: boolean; snapshot: AgentSnapshot }
  | HostSnapshotResult
  | HostAckResult
  | HostEndpointListResult
  | HostEndpointSaveResult
  | { kind: 'attachment'; receipt: AttachmentReceipt }
  | HostCheckpointResult
export type HostResultFor<Command extends HostCommand> = Command extends { type: 'subagent:inspect' }
  ? { kind: 'subagent-inspection'; snapshot: AgentSnapshot }
  : Command extends SessionSearchCommand
  ? { kind: 'session-search'; result: SessionSearchResult }
  : Command extends ProjectSearchCommand
  ? { kind: 'project-search'; result: ProjectSearchResult }
  : Command extends { type: 'skills:list' }
  ? { kind: 'skills-list'; catalog: import('./skills').SkillsCatalogSnapshot }
  : Command extends { type: 'skills:detail' }
  ? { kind: 'skills-detail'; detail: import('./skills').SkillDetail }
  : Command extends import('./mcp').McpCommand
  ? { kind: 'mcp'; result: import('./mcp').McpSnapshot }
  : Command extends { type: 'account:quota' }
  ? { kind: 'account-quota'; quota: import('./account-quota').AccountQuota }
  : Command extends { type: 'account:token' }
  ? { kind: 'account-token'; token: import('./engine-credentials').ChatgptAccessToken }
  : Command extends ProjectCatalogCommand
  ? { kind: 'project-catalog'; catalog: ProjectCatalog }
  : Command extends SessionEditCommand
  ? { kind: 'session-edit'; result: SessionEditResult }
  : Command extends CheckpointCommand
  ? HostCheckpointResult
  : Command extends { type: 'session:fork' }
    ? { kind: 'session-fork'; cancelled: boolean; snapshot: AgentSnapshot }
    : Command extends SnapshotHostCommand
      ? HostSnapshotResult
      : Command extends AttachmentHostCommand
        ? { kind: 'attachment'; receipt: AttachmentReceipt }
        : Command extends { type: 'endpoint:discover' }
          ? HostEndpointDiscoveryResult
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
  | { type: 'event'; event: 'open-external'; data: { url: string; mcp?: true } }

export type HostMessage = HostResponse | HostEvent

export type DesktopEvent =
  | HostEvent
  | { type: 'event'; event: 'sessions'; data: LiveSessionSummary[] }
  | { type: 'event'; event: 'navigation-library'; data: import('./navigation-library').NavigationLibraryState }
  | { type: 'event'; event: 'command-palette'; data: { source: 'native-view'; token: string } }
  | { type: 'event'; event: 'mobile-gateway'; data: import('./mobile-gateway').MobileGatewayState }
  | { type: 'event'; event: 'credential-grant'; data: import('./engine-credentials').CredentialGrantPrompt }
  | { type: 'event'; event: 'credential-grant-closed'; data: { id: string } }
  | {
      type: 'event'
      event: 'disconnected'
      data: { message: string }
    }

export type PiDesktopAPI = {
  /** The interface language Main chose at start. */
  locale: import('./i18n').Locale
  /** Restarts the app, e.g. to apply a new interface language. */
  relaunch: () => Promise<void>
  navigationLibrary: (command: import('./navigation-library').NavigationLibraryCommand) => Promise<import('./navigation-library').NavigationLibraryState>
  nativePaletteFocus: (command: import('./native-palette-focus').NativePaletteFocusCommand) => Promise<void>
  desktopSettings: (command: import('./desktop-settings').DesktopSettingsCommand) => Promise<import('./desktop-settings').DesktopSettings>
  mobileGateway: (command: import('./mobile-gateway').MobileGatewayCommand) => Promise<import('./mobile-gateway').MobileGatewayState>
  exportMarkdownTable: (
    request: import('./markdown-table-export').MarkdownTableRequest
  ) => Promise<import('./markdown-table-export').MarkdownTableResult>
  textAttachments: (command: AttachmentCommand) => Promise<AttachmentResult>
  terminal: (command: TerminalCommand) => Promise<TerminalResult>
  /** New versions of the app itself, from the repository's GitHub releases. */
  appUpdate: (
    command: import('./app-updates').AppUpdateCommand
  ) => Promise<import('./app-updates').AppUpdateStatus>
  /** Local logs and crash records; export writes a redacted report the user chooses to share. */
  diagnostics: <Command extends import('./diagnostics').DiagnosticsCommand>(
    command: Command
  ) => Promise<import('./diagnostics').DiagnosticsResult<Command>>
  onAppUpdate: (listener: (status: import('./app-updates').AppUpdateStatus) => void) => () => void
  onTerminalEvent: (listener: (event: TerminalEvent) => void) => () => void
  gitReview: (command: GitReviewCommand) => Promise<GitReviewResult>
  workspaceFiles: (command: WorkspaceFilesCommand) => Promise<WorkspaceFilesResult>
  desktopControl: (
    command: import('./desktop-control').DesktopControlCommand
  ) => Promise<import('./desktop-control').DesktopControlResult>
  getState: () => Promise<AgentSnapshot>
  legacyPiHistory: () => Promise<{ location: string; count: number }>
  importPiHistory: () => Promise<{ imported: number; skipped: number }>
  selectRuntime: (runtimeId: string, origin?: DesktopCommandOrigin) => Promise<AgentSnapshot>
  /** Accounts of every engine, read from configuration hosts; independent of the open chat. */
  runtimeAccounts: () => Promise<RuntimeAccounts[]>
  /** Answers "may this engine use this ChatGPT account?". */
  respondCredentialGrant: (
    id: string,
    decision: import('./engine-credentials').CredentialGrantDecision
  ) => Promise<void>
  credentialGrants: () => Promise<import('./engine-credentials').CredentialGrant[]>
  revokeCredentialGrant: (
    runtimeId: string,
    account: string
  ) => Promise<import('./engine-credentials').CredentialGrant[]>
  /** Downloads or removes an engine's CLI; progress shows up in `runtimeAccounts`. */
  engineBinary: (
    runtimeId: string,
    action: 'install' | 'remove'
  ) => Promise<import('./engine-binaries').EngineBinaryStatus>
  /** Account and endpoint commands addressed to one engine's configuration, not the open chat. */
  runtimeConfig: <Command extends RuntimeConfigCommand>(
    runtimeId: string,
    command: Command
  ) => Promise<HostResultFor<Command>>
  /** Engine new chats use; picking another engine in the sidebar does not change it. */
  defaultRuntime: () => Promise<string>
  setDefaultRuntime: (runtimeId: string) => Promise<void>
  listRuntimes: () => Promise<import('./agent-runtime').AgentRuntimeManifest[]>
  reconnect: () => Promise<AgentSnapshot>
  selectProject: (origin?: DesktopCommandOrigin) => Promise<AgentSnapshot | null>
  inspectSubagent: (taskId: string, origin: DesktopCommandOrigin) => Promise<AgentSnapshot>
  selectSession: (workerId: string, origin?: DesktopCommandOrigin) => Promise<AgentSnapshot>
  send: <Command extends HostCommand>(command: Command, origin?: DesktopCommandOrigin) => Promise<HostResultFor<Command>>
  onEvent: (listener: (event: DesktopEvent) => void) => () => void
  browser: (command: BrowserCommand) => Promise<BrowserCommandResult>
  onBrowserEvent: (listener: (event: BrowserEvent) => void) => () => void
  workbench: (command: WorkbenchCommand) => Promise<WorkbenchCommandResult>
  onWorkbenchEvent: (listener: (event: WorkbenchEvent) => void) => () => void
}
