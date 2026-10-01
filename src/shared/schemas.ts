import { subagentOperationSchema } from './subagent'
import { navigationLibrarySchema } from './navigation-library'
import { z } from 'zod'
import { sessionSearchCommandSchema, projectSearchCommandSchema, sessionSearchResultSchema, projectSearchResultSchema } from './session-search'
import { skillsListSchema, skillsDetailSchema, skillsCatalogSchema, skillDetailSchema } from './skills'
import { mcpListSchema, mcpShutdownSchema, mcpSaveSchema, mcpToggleSchema, mcpReloadSchema, mcpLoginSchema, mcpLogoutSchema, mcpSnapshotSchema } from './mcp'
import { accountQuotaCommandSchema, accountQuotaSchema } from './account-quota'
import { messageFeedbackCommandSchema, messageFeedbackDataSchema } from './message-actions'
import {
  checkpointPlanCommandSchema,
  checkpointRestoreCommandSchema,
  checkpointResultSchema,
  checkpointTurnStateSchema
} from './checkpoints'
import { permissionRulesCommandSchema, permissionRulesSchema } from './permission-rules'
import {
  editPrepareSchema,
  editCancelSchema,
  editSendSchema,
  editQuerySchema,
  editResultSchema
} from './session-edit'
import {
  attachmentPromptCommandSchema,
  attachmentQueryCommandSchema,
  attachmentReceiptSchema
} from './text-attachments'
import { browserRefSchema } from './browser-ref'
import {
  endpointDiscoverSchema,
  endpointDiscoverySchema,
  customEndpointConfigSnapshotSchema,
  customEndpointContextSchema,
  customEndpointSaveRequestSchema,
  customEndpointSaveResultSchema
} from './custom-endpoints'
import { THINKING_LEVELS } from './contracts'
import { agentRuntimeManifestSchema, runtimeIdSchema } from './agent-runtime'
import { normalizeSessionName } from './session-name'
import type {
  AgentSnapshot,
  AgentStatePatch,
  BrowserCapabilityCancel,
  BrowserCapabilityRequest,
  BrowserCapabilityResponse,
  BrowserCommand,
  BrowserEvent,
  BrowserOperation,
  ComputerUseCapabilityCancel,
  ComputerUseCapabilityRequest,
  ComputerUseCapabilityResponse,
  HostCommand,
  HostEvent,
  HostMessage,
  HostRequest,
  HostResponse,
  HostResult
} from './contracts'
import {
  computerUseOperationSchema,
  computerUseResultSchema
} from './computer-use'

const nonNegativeInteger = z.number().int().nonnegative()
const permissionModeSchema = z.enum(['open', 'auto', 'ask'])
export const thinkingLevelSchema = z.enum(THINKING_LEVELS)
const sessionStatusSchema = z.enum(['idle', 'running', 'awaiting-approval', 'error', 'stopped'])
const toolIntentSchema = z.enum(['terminal', 'read', 'diff', 'search', 'web', 'desktop', 'generic'])
const toolStatusSchema = z.enum([
  'queued',
  'awaiting-approval',
  'waiting-resource',
  'incomplete',
  'running',
  'success',
  'error',
  'blocked'
])

const nodeIdentitySchema = {
  id: z.string(),
  presentationIdentity: z.string().min(1).max(1024).optional()
}
const conversationNodeSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...nodeIdentitySchema,
      type: z.literal('model'),
      provider: z.string(),
      modelId: z.string(),
      name: z.string().optional(),
      initial: z.boolean()
    })
    .strict(),
  z
    .object({
      ...nodeIdentitySchema,
      type: z.literal('compaction'),
      tokensBefore: nonNegativeInteger
    })
    .strict(),
  z
    .object({
      ...nodeIdentitySchema,
      type: z.literal('user'),
      text: z.string(),
      canonicalEntryId: z.string().min(1).optional(),
      imageCount: nonNegativeInteger.optional()
    })
    .strict(),
  z
    .object({
      ...nodeIdentitySchema,
      type: z.literal('assistant'),
      markdown: z.string(),
      canonicalEntryId: z.string().min(1).optional(),
      feedback: messageFeedbackDataSchema.shape.value.optional(),
      streaming: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      ...nodeIdentitySchema,
      type: z.literal('think'),
      text: z.string(),
      streaming: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      ...nodeIdentitySchema,
      type: z.literal('tool'),
      toolCallId: z.string(),
      name: z.string(),
      intent: toolIntentSchema,
      title: z.string(),
      detail: z.string().optional(),
      output: z.string().optional(),
      durationMs: nonNegativeInteger.optional(),
      originalOutputLength: nonNegativeInteger.optional(),
      truncated: z.boolean().optional(),
      status: toolStatusSchema,
      subagent: subagentOperationSchema.optional(),
      change: z
        .object({
          path: z.string(),
          kind: z.enum(['edit', 'write']),
          source: z.enum(['proposed', 'applied']),
          anchored: z.boolean(),
          patch: z.string(),
          additions: nonNegativeInteger,
          deletions: nonNegativeInteger,
          omitted: z.boolean().optional()
        })
        .strict()
        .optional()
    })
    .strict(),
  z.object({ ...nodeIdentitySchema, type: z.literal('error'), message: z.string() }).strict(),
  z.object({ ...nodeIdentitySchema, type: z.literal('stopped'), message: z.string() }).strict()
])

const projectInfoSchema = z.object({ path: z.string(), name: z.string() }).strict()
const sessionSummarySchema = z
  .object({
    id: z.string(),
    runtimeId: runtimeIdSchema.optional(),
    path: z.string(),
    title: z.string(),
    modified: z.string(),
    messageCount: nonNegativeInteger,
    active: z.boolean(),
    status: sessionStatusSchema,
    parentSessionPath: z.string().optional(),
    parentUnavailable: z.boolean().optional()
  })
  .strict()
const accountSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    authType: z.enum(['api_key', 'oauth']),
    connected: z.boolean(),
    subscription: z.boolean(),
    alias: z.boolean(),
    platform: z.enum(['chatgpt', 'claude']).optional(),
    email: z.string().max(254).optional(),
    plan: z.string().max(40).optional(),
    endpoint: z.string().max(253).optional()
  })
  .strict()
const modelSummarySchema = z
  .object({
    provider: z.string(),
    id: z.string(),
    name: z.string(),
    contextWindow: nonNegativeInteger,
    reasoning: z.boolean(),
    input: z.array(z.enum(['text', 'image'])).optional(),
    unavailableReason: z.string().optional()
  })
  .strict()
const modelAvailabilitySchema = z.enum(['available', 'unavailable', 'unselected'])
const composeBlockReasonSchema = z
  .enum([
    'project-required',
    'login-required',
    'model-required',
    'model-unavailable',
    'pinned-model-unavailable',
    'endpoint-runtime-unsynchronized',
    'endpoint-selection-invalidated'
  ])
  .nullable()
const usageMetricsSchema = z
  .object({
    turns: nonNegativeInteger,
    steps: nonNegativeInteger,
    input: nonNegativeInteger,
    output: nonNegativeInteger,
    cacheRead: nonNegativeInteger,
    cacheWrite: nonNegativeInteger,
    contextTokens: nonNegativeInteger.optional(),
    contextWindow: nonNegativeInteger.optional(),
    contextPercent: z.number().nonnegative().optional(),
    llmDurationMs: z.number().nonnegative().optional(),
    firstTokenMs: z.number().nonnegative().optional(),
    tokensPerSecond: z.number().nonnegative().optional(),
    usageIncomplete: z.boolean().optional()
  })
  .strict()
const approvalRequestSchema = z
  .object({
    id: z.string().min(1),
    generation: nonNegativeInteger,
    toolCallId: z.string(),
    toolName: z.string(),
    intent: toolIntentSchema,
    title: z.string(),
    detail: z.string(),
    grant: z
      .object({
        kind: z.literal('computer-app'),
        app: z.string().max(80),
        bundleId: z.string().min(1).max(80)
      })
      .strict()
      .optional()
  })
  .strict()
const loginStatusSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('idle') }).strict(),
  z.object({ phase: z.literal('starting'), providerId: z.string() }).strict(),
  z
    .object({
      phase: z.literal('browser'),
      providerId: z.string(),
      url: z.string(),
      instructions: z.string().optional()
    })
    .strict(),
  z
    .object({
      phase: z.literal('device_code'),
      providerId: z.string(),
      userCode: z.string(),
      verificationUri: z.string(),
      expiresInSeconds: z.number().positive().optional()
    })
    .strict(),
  z.object({ phase: z.literal('waiting'), providerId: z.string(), message: z.string() }).strict(),
  z.object({ phase: z.literal('success'), providerId: z.string() }).strict(),
  z.object({ phase: z.literal('error'), providerId: z.string(), message: z.string() }).strict()
])
const loginPromptSchema = z
  .object({
    id: z.string().min(1),
    providerId: z.string(),
    type: z.enum(['text', 'secret', 'select', 'manual_code']),
    message: z.string(),
    placeholder: z.string().optional(),
    options: z
      .array(
        z
          .object({
            id: z.string(),
            label: z.string(),
            description: z.string().optional()
          })
          .strict()
      )
      .optional()
  })
  .strict()

const browserPageTargetShape = { pageId: z.string().min(1).optional() }

export const browserOperationSchema: z.ZodType<BrowserOperation> = z.discriminatedUnion('action', [
  z.object({ action: z.literal('tabs') }).strict(),
  z.object({ action: z.literal('new_tab'), url: z.string().min(1).optional() }).strict(),
  z.object({ action: z.literal('select_tab'), pageId: z.string().min(1) }).strict(),
  z.object({ action: z.literal('close_tab'), pageId: z.string().min(1) }).strict(),
  z
    .object({ action: z.literal('navigate'), url: z.string().min(1), ...browserPageTargetShape })
    .strict(),
  ...(['back', 'forward', 'reload', 'snapshot', 'screenshot'] as const).map((action) =>
    z.object({ action: z.literal(action), ...browserPageTargetShape }).strict()
  ),
  z
    .object({ action: z.literal('click'), ref: browserRefSchema, ...browserPageTargetShape })
    .strict(),
  ...(['fill', 'select'] as const).map((action) =>
    z
      .object({
        action: z.literal(action),
        ref: browserRefSchema,
        value: z.string().max(10000),
        ...browserPageTargetShape
      })
      .strict()
  ),
  z
    .object({ action: z.literal('keypress'), key: z.string().min(1), ...browserPageTargetShape })
    .strict(),
  z
    .object({
      action: z.literal('scroll'),
      direction: z.enum(['up', 'down', 'left', 'right']),
      amount: z.number().int().positive().max(4000).optional(),
      ...browserPageTargetShape
    })
    .strict(),
  z
    .object({
      action: z.literal('wait'),
      text: z.string().min(1).max(10000).optional(),
      url: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive().max(30_000).optional(),
      ...browserPageTargetShape
    })
    .strict()
])

export const browserCommandSchema: z.ZodType<BrowserCommand> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state:get') }).strict(),
  z.object({ type: z.literal('operate'), operation: browserOperationSchema }).strict(),
  z.object({ type: z.literal('agent:stop') }).strict(),
  z.object({ type: z.literal('e2e:agent'), operation: browserOperationSchema }).strict()
])

export const browserCapabilityRequestSchema: z.ZodType<BrowserCapabilityRequest> = z
  .object({
    type: z.literal('capability-request'),
    capability: z.literal('browser'),
    requestId: z.string().min(1),
    sessionId: z.string().nullable(),
    generation: nonNegativeInteger,
    operation: browserOperationSchema
  })
  .strict()

export const browserCapabilityCancelSchema: z.ZodType<BrowserCapabilityCancel> = z
  .object({
    type: z.literal('capability-cancel'),
    capability: z.literal('browser'),
    requestId: z.string().min(1)
  })
  .strict()

const browserStateSchema = z
  .object({
    available: z.boolean(),
    visible: z.boolean(),
    pages: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          url: z.string(),
          active: z.boolean(),
          loading: z.boolean(),
          canGoBack: z.boolean(),
          canGoForward: z.boolean()
        })
        .strict()
    ),
    activePageId: z.string().nullable(),
    controller: z.enum(['idle', 'user', 'agent']),
    lastAction: z.string().optional(),
    error: z.string().optional()
  })
  .strict()

export const browserEventSchema: z.ZodType<BrowserEvent> = z
  .object({ type: z.literal('state'), data: browserStateSchema })
  .strict()

const browserOperationResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), state: browserStateSchema }).strict(),
  z
    .object({
      kind: z.literal('snapshot'),
      pageId: z.string(),
      pageRevision: nonNegativeInteger,
      url: z.string(),
      title: z.string(),
      text: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal('screenshot'),
      pageId: z.string(),
      url: z.string(),
      mimeType: z.literal('image/png'),
      data: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal('action'),
      pageId: z.string(),
      pageRevision: nonNegativeInteger,
      url: z.string(),
      message: z.string()
    })
    .strict()
])

export const browserCapabilityResponseSchema: z.ZodType<BrowserCapabilityResponse> =
  z.discriminatedUnion('ok', [
    z
      .object({
        type: z.literal('capability-response'),
        capability: z.literal('browser'),
        requestId: z.string().min(1),
        ok: z.literal(true),
        data: browserOperationResultSchema
      })
      .strict(),
    z
      .object({
        type: z.literal('capability-response'),
        capability: z.literal('browser'),
        requestId: z.string().min(1),
        ok: z.literal(false),
        error: z.string()
      })
      .strict()
  ])

export const computerUseCapabilityRequestSchema: z.ZodType<ComputerUseCapabilityRequest> = z
  .object({
    type: z.literal('capability-request'),
    capability: z.literal('computer-use'),
    requestId: z.string().min(1),
    sessionId: z.string().nullable(),
    generation: nonNegativeInteger,
    operation: computerUseOperationSchema
  })
  .strict()

export const computerUseCapabilityCancelSchema: z.ZodType<ComputerUseCapabilityCancel> = z
  .object({
    type: z.literal('capability-cancel'),
    capability: z.literal('computer-use'),
    requestId: z.string().min(1)
  })
  .strict()

export const computerUseCapabilityResponseSchema: z.ZodType<ComputerUseCapabilityResponse> =
  z.discriminatedUnion('ok', [
    z
      .object({
        type: z.literal('capability-response'),
        capability: z.literal('computer-use'),
        requestId: z.string().min(1),
        ok: z.literal(true),
        data: computerUseResultSchema
      })
      .strict(),
    z
      .object({
        type: z.literal('capability-response'),
        capability: z.literal('computer-use'),
        requestId: z.string().min(1),
        ok: z.literal(false),
        error: z.string()
      })
      .strict()
  ])

const agentSnapshotMetaShape = {
  desktopScope: z.object({ workerId: z.string().min(1).max(128), selectionEpoch: z.number().int().nonnegative() }).strict().optional(),
  edit: z
    .object({
      entryId: z.string().nullable(),
      leafId: z.string().nullable(),
      reason: z.string().nullable(),
      pending: z.boolean()
    })
    .strict()
    .optional(),
  fork: z
    .object({ entryId: z.string().nullable(), reason: z.string().nullable() })
    .strict()
    .optional(),
  ready: z.boolean(),
  engine: z.string().min(1).max(200),
  runtime: agentRuntimeManifestSchema.optional(),
  agentDir: z.string(),
  project: projectInfoSchema.nullable(),
  sessions: z.array(sessionSummarySchema),
  activeSessionPath: z.string().nullable(),
  accounts: z.array(accountSummarySchema),
  models: z.array(modelSummarySchema),
  activeProvider: z.string().nullable(),
  activeModel: z.string().nullable(),
  thinking: z
    .object({ level: thinkingLevelSchema, available: z.array(thinkingLevelSchema).max(8) })
    .strict()
    .nullable()
    .optional(),
  modelAvailability: modelAvailabilitySchema,
  composeBlockReason: composeBlockReasonSchema,
  busy: z.boolean(),
  status: sessionStatusSchema,
  approvals: z.array(approvalRequestSchema),
  followUp: z.array(z.string()),
  queuedCount: nonNegativeInteger,
  permissionMode: permissionModeSchema,
  metrics: usageMetricsSchema,
  login: loginStatusSchema,
  authGeneration: nonNegativeInteger.optional(),
  loginPrompt: loginPromptSchema.nullable(),
  checkpoints: z.array(checkpointTurnStateSchema).optional(),
  permissionRules: permissionRulesSchema.optional(),
  error: z.string().optional()
}

const agentSnapshotMetaSchema = z.object(agentSnapshotMetaShape).partial().strict()

export const agentSnapshotSchema: z.ZodType<AgentSnapshot> = z
  .object({
    sessionId: z.string().nullable(),
    generation: nonNegativeInteger,
    revision: nonNegativeInteger,
    ...agentSnapshotMetaShape,
    nodes: z.array(conversationNodeSchema)
  })
  .strict()

export const agentStatePatchSchema: z.ZodType<AgentStatePatch> = z
  .object({
    sessionId: z.string().nullable(),
    generation: nonNegativeInteger,
    baseRevision: nonNegativeInteger,
    revision: nonNegativeInteger,
    nodeUpserts: z.array(conversationNodeSchema),
    removedNodeIds: z.array(z.string()),
    nodeOrder: z.array(z.string()).optional(),
    meta: agentSnapshotMetaSchema
  })
  .strict()

const bootstrapCommandSchema = z.object({ type: z.literal('bootstrap') }).strict()
const stateGetCommandSchema = z.object({ type: z.literal('state:get'), refreshSessions: z.boolean().optional() }).strict()
const runtimeRefreshCommandSchema = z.object({ type: z.literal('runtime:refresh') }).strict()
const runtimeShutdownCommandSchema = z.object({ type: z.literal('runtime:shutdown') }).strict()
const projectOpenCommandSchema = z
  .object({ type: z.literal('project:open'), cwd: z.string().min(1), runtimeId: runtimeIdSchema.optional() })
  .strict()
const projectCatalogCommandSchema = z.object({
  type: z.literal('project:catalog'),
  cwd: z.string().min(1).optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
  recentPaths: z.array(z.string().min(1)).max(100).optional(),
  includeHidden: z.boolean().optional(),
  includeArchived: z.boolean().optional(),
  navigation: navigationLibrarySchema.optional()
}).strict()
const projectNavigateCommandSchema = z.object({
  type: z.literal('project:navigate'),
  cwd: z.string().min(1),
  runtimeId: runtimeIdSchema.optional(),
  sessionPath: z.string().min(1).optional(),
  sessionId: z.string().min(1).nullable(),
  generation: nonNegativeInteger
}).strict()
const sessionNewBareCommandSchema = z.object({ type: z.literal('session:new'), runtimeId: runtimeIdSchema.optional() }).strict()
const sessionNewExactCommandSchema = z
  .object({
    type: z.literal('session:new'),
    runtimeId: runtimeIdSchema.optional(),
    providerId: z.string().min(1),
    modelId: z.string().min(1)
  })
  .strict()
const sessionNewCommandSchema = z.union([sessionNewBareCommandSchema, sessionNewExactCommandSchema])
const sessionOpenCommandSchema = z
  .object({ type: z.literal('session:open'), path: z.string().min(1) })
  .strict()
const sessionForkCommandSchema = z
  .object({
    type: z.literal('session:fork'),
    sessionId: z.string().min(1),
    generation: nonNegativeInteger,
    entryId: z.string().min(1)
  })
  .strict()
const sessionRenameCommandSchema = z
  .object({
    type: z.literal('session:rename'),
    sessionId: z.string().min(1),
    generation: nonNegativeInteger,
    name: z.string().superRefine((name, context) => {
      try {
        normalizeSessionName(name)
      } catch (error) {
        context.addIssue({ code: 'custom', message: (error as Error).message })
      }
    })
  })
  .strict()
export const MAX_PROMPT_IMAGES = 4
/** Base64 characters per image: about 6 MiB decoded. */
export const MAX_PROMPT_IMAGE_CHARS = 8 * 1024 * 1024
export const promptImageSchema = z
  .object({
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    data: z
      .string()
      .min(1)
      .max(MAX_PROMPT_IMAGE_CHARS)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
  })
  .strict()
const promptSendCommandSchema = z
  .object({
    type: z.literal('prompt:send'),
    // May be empty only when images carry the request; the Host rejects an empty prompt.
    text: z.string(),
    sessionId: z.string().min(1),
    generation: nonNegativeInteger,
    images: z.array(promptImageSchema).min(1).max(MAX_PROMPT_IMAGES).optional()
  })
  .strict()
const sessionTaskCancelCommandSchema = z.object({ type: z.literal('session-task:cancel'), taskId: z.string().min(1).max(256), sessionId: z.string().min(1).max(1024), generation: nonNegativeInteger }).strict()
const subagentInspectCommandSchema = z.object({ type: z.literal('subagent:inspect'), taskId: z.string().min(1).max(256), sessionId: z.string().min(1), generation: nonNegativeInteger }).strict()
const accountApiKeySetCommandSchema = z.object({ type: z.literal('account:api-key:set'), providerId: z.string().min(1).max(128), apiKey: z.string().min(1).max(16384), baseUrl: z.string().url().max(4096).optional(), label: z.string().trim().min(1).max(80).optional() }).strict()
const promptAbortCommandSchema = z.object({ type: z.literal('prompt:abort') }).strict()
const queueClearCommandSchema = z.object({ type: z.literal('queue:clear') }).strict()
const permissionSetCommandSchema = z
  .object({ type: z.literal('permission:set'), mode: permissionModeSchema })
  .strict()
const permissionRespondCommandSchema = z
  .object({
    type: z.literal('permission:respond'),
    approvalId: z.string().min(1),
    allow: z.boolean(),
    scope: z.enum(['once', 'turn']).optional()
  })
  .strict()
const accountLoginCommandSchema = z
  .object({
    type: z.literal('account:login'),
    providerId: z.string().min(1),
    method: z.enum(['browser', 'device_code'])
  })
  .strict()
const accountLoginRespondCommandSchema = z
  .object({
    type: z.literal('account:login:respond'),
    promptId: z.string().min(1),
    value: z.string().optional()
  })
  .strict()
const accountAliasAddCommandSchema = z
  .object({ type: z.literal('account:alias:add'), slug: z.string().min(1) })
  .strict()
const accountAddCommandSchema = z
  .object({
    type: z.literal('account:add'),
    platform: z.enum(['chatgpt', 'claude']),
    method: z.enum(['browser', 'device_code'])
  })
  .strict()
const accountRemoveCommandSchema = z
  .object({ type: z.literal('account:remove'), providerId: z.string().min(1).max(120) })
  .strict()
const thinkingSetCommandSchema = z
  .object({ type: z.literal('thinking:set'), level: thinkingLevelSchema })
  .strict()
const modelSetCommandSchema = z
  .object({
    type: z.literal('model:set'),
    providerId: z.string().min(1),
    modelId: z.string().min(1)
  })
  .strict()
const browserE2ECommandSchema = z
  .object({ type: z.literal('browser:e2e'), operation: browserOperationSchema })
  .strict()

const endpointListCommandSchema = z.object({ type: z.literal('endpoint:list') }).strict()
const endpointSaveCommandSchema = z
  .object({
    type: z.literal('endpoint:save'),
    context: customEndpointContextSchema,
    request: customEndpointSaveRequestSchema
  })
  .strict()
const commandSchemas = [
  sessionSearchCommandSchema, projectSearchCommandSchema,
  skillsListSchema, skillsDetailSchema,
  mcpListSchema, mcpShutdownSchema, mcpSaveSchema, mcpToggleSchema, mcpReloadSchema, mcpLoginSchema, mcpLogoutSchema,
  accountQuotaCommandSchema,
  messageFeedbackCommandSchema,
  checkpointPlanCommandSchema,
  checkpointRestoreCommandSchema,
  permissionRulesCommandSchema,
  projectCatalogCommandSchema,
  projectNavigateCommandSchema,
  editPrepareSchema,
  editCancelSchema,
  editSendSchema,
  editQuerySchema,
  attachmentPromptCommandSchema,
  attachmentQueryCommandSchema,
  endpointDiscoverSchema,
  endpointListCommandSchema,
  endpointSaveCommandSchema,
  bootstrapCommandSchema,
  stateGetCommandSchema,
  runtimeRefreshCommandSchema,
  runtimeShutdownCommandSchema,
  projectOpenCommandSchema,
  sessionNewCommandSchema,
  sessionOpenCommandSchema,
  sessionForkCommandSchema,
  sessionRenameCommandSchema,
  promptSendCommandSchema,
  promptAbortCommandSchema,
  sessionTaskCancelCommandSchema,
  subagentInspectCommandSchema,
  accountApiKeySetCommandSchema,
  queueClearCommandSchema,
  permissionSetCommandSchema,
  permissionRespondCommandSchema,
  accountLoginCommandSchema,
  accountLoginRespondCommandSchema,
  accountAliasAddCommandSchema,
  accountAddCommandSchema,
  accountRemoveCommandSchema,
  modelSetCommandSchema,
  thinkingSetCommandSchema,
  browserE2ECommandSchema
] as const

export const hostCommandSchema: z.ZodType<HostCommand> = z.union(commandSchemas)

const requestIdShape = { requestId: z.string().min(1), expectedIdentity: z.object({ sessionId: z.string().nullable(), generation: nonNegativeInteger }).strict().optional() }
export const hostRequestSchema: z.ZodType<HostRequest> = z.union([
  sessionSearchCommandSchema.extend({ ...requestIdShape, recentPaths: z.array(z.string().min(1).max(4096)).max(100).optional() }),
  projectSearchCommandSchema.extend({ ...requestIdShape, recentPaths: z.array(z.string().min(1).max(4096)).max(100).optional() }),
  skillsListSchema.extend(requestIdShape),
  skillsDetailSchema.extend(requestIdShape),
  mcpListSchema.extend(requestIdShape),
  mcpShutdownSchema.extend(requestIdShape),
  mcpSaveSchema.extend(requestIdShape),
  mcpToggleSchema.extend(requestIdShape),
  mcpReloadSchema.extend(requestIdShape),
  mcpLoginSchema.extend(requestIdShape),
  mcpLogoutSchema.extend(requestIdShape),
  accountQuotaCommandSchema.extend(requestIdShape),
  messageFeedbackCommandSchema.extend(requestIdShape),
  checkpointPlanCommandSchema.extend(requestIdShape),
  checkpointRestoreCommandSchema.extend(requestIdShape),
  permissionRulesCommandSchema.extend(requestIdShape),
  projectCatalogCommandSchema.extend(requestIdShape),
  projectNavigateCommandSchema.extend(requestIdShape),
  editPrepareSchema.extend(requestIdShape),
  editCancelSchema.extend(requestIdShape),
  editSendSchema.extend(requestIdShape),
  editQuerySchema.extend(requestIdShape),
  attachmentPromptCommandSchema.extend(requestIdShape),
  attachmentQueryCommandSchema.extend(requestIdShape),
  endpointDiscoverSchema.extend(requestIdShape),
  endpointListCommandSchema.extend(requestIdShape),
  endpointSaveCommandSchema.extend(requestIdShape),
  bootstrapCommandSchema.extend(requestIdShape),
  stateGetCommandSchema.extend(requestIdShape),
  runtimeRefreshCommandSchema.extend(requestIdShape),
  runtimeShutdownCommandSchema.extend(requestIdShape),
  projectOpenCommandSchema.extend(requestIdShape),
  sessionNewBareCommandSchema.extend(requestIdShape),
  sessionNewExactCommandSchema.extend(requestIdShape),
  sessionOpenCommandSchema.extend(requestIdShape),
  sessionForkCommandSchema.extend(requestIdShape),
  sessionRenameCommandSchema.extend(requestIdShape),
  promptSendCommandSchema.extend(requestIdShape),
  promptAbortCommandSchema.extend(requestIdShape),
  sessionTaskCancelCommandSchema.extend(requestIdShape),
  subagentInspectCommandSchema.extend(requestIdShape),
  accountApiKeySetCommandSchema.extend(requestIdShape),
  queueClearCommandSchema.extend(requestIdShape),
  permissionSetCommandSchema.extend(requestIdShape),
  permissionRespondCommandSchema.extend(requestIdShape),
  accountLoginCommandSchema.extend(requestIdShape),
  accountLoginRespondCommandSchema.extend(requestIdShape),
  accountAliasAddCommandSchema.extend(requestIdShape),
  accountAddCommandSchema.extend(requestIdShape),
  accountRemoveCommandSchema.extend(requestIdShape),
  modelSetCommandSchema.extend(requestIdShape),
  thinkingSetCommandSchema.extend(requestIdShape),
  browserE2ECommandSchema.extend(requestIdShape)
])

export const hostResultSchema: z.ZodType<HostResult> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session-search'), result: sessionSearchResultSchema }).strict(),
  z.object({ kind: z.literal('project-search'), result: projectSearchResultSchema }).strict(),
  z.object({ kind: z.literal('skills-list'), catalog: skillsCatalogSchema }).strict(),
  z.object({ kind: z.literal('skills-detail'), detail: skillDetailSchema }).strict(),
  z.object({ kind: z.literal('mcp'), result: mcpSnapshotSchema }).strict(),
  z.object({ kind: z.literal('account-quota'), quota: accountQuotaSchema }).strict(),
  z.object({kind:z.literal('project-catalog'),catalog:z.object({
    projects:z.array(z.object({
      path:z.string().min(1),name:z.string().min(1),sessions:z.array(sessionSummarySchema),
      totalSessions:nonNegativeInteger,nextOffset:nonNegativeInteger.nullable(),
      error:z.literal('directory-unavailable').optional()
  }).strict()).max(100),totalProjects:nonNegativeInteger,truncated:z.boolean(),skippedDirectories:nonNegativeInteger.optional()
  }).strict()}).strict(),
  z.object({ kind: z.literal('subagent-inspection'), snapshot: agentSnapshotSchema }).strict(),
  z.object({ kind: z.literal('session-edit'), result: editResultSchema }).strict(),
  z
    .object({
      kind: z.literal('session-fork'),
      cancelled: z.boolean(),
      snapshot: agentSnapshotSchema
    })
    .strict(),
  z.object({ kind: z.literal('attachment'), receipt: attachmentReceiptSchema }).strict(),
  checkpointResultSchema,
  z
    .object({
      kind: z.literal('endpoint-list'),
      snapshot: customEndpointConfigSnapshotSchema,
      configPath: z.string()
    })
    .strict(),
  z.object({ kind: z.literal('endpoint-discovery'), result: endpointDiscoverySchema }).strict(),
  z.object({ kind: z.literal('endpoint-save'), result: customEndpointSaveResultSchema }).strict(),
  z.object({ kind: z.literal('snapshot'), snapshot: agentSnapshotSchema }).strict(),
  z
    .object({
      kind: z.literal('ack'),
      sessionId: z.string().nullable(),
      generation: nonNegativeInteger,
      revision: nonNegativeInteger
    })
    .strict()
])

export const hostResponseSchema: z.ZodType<HostResponse> = z.discriminatedUnion('ok', [
  z
    .object({
      type: z.literal('response'),
      requestId: z.string().min(1),
      ok: z.literal(true),
      data: hostResultSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('response'),
      requestId: z.string().min(1),
      ok: z.literal(false),
      error: z.string()
    })
    .strict()
])

export const hostEventSchema: z.ZodType<HostEvent> = z.discriminatedUnion('event', [
  z
    .object({ type: z.literal('event'), event: z.literal('snapshot'), data: agentSnapshotSchema })
    .strict(),
  z
    .object({ type: z.literal('event'), event: z.literal('patch'), data: agentStatePatchSchema })
    .strict(),
  z
    .object({
      type: z.literal('event'),
      event: z.literal('open-external'),
      data: z.object({ url: z.string(), mcp: z.literal(true).optional() }).strict()
    })
    .strict()
])

export const hostMessageSchema: z.ZodType<HostMessage> = z.union([
  hostResponseSchema,
  hostEventSchema
])

export * from './workbench-schemas'
