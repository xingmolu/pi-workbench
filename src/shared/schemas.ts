import { z } from 'zod'
import { AGENT_ENGINE } from './contracts'
import type {
  AgentSnapshot,
  AgentStatePatch,
  BrowserCapabilityCancel,
  BrowserCapabilityRequest,
  BrowserCapabilityResponse,
  BrowserCommand,
  BrowserEvent,
  BrowserOperation,
  HostCommand,
  HostEvent,
  HostMessage,
  HostRequest,
  HostResponse,
  HostResult
} from './contracts'

const nonNegativeInteger = z.number().int().nonnegative()
const permissionModeSchema = z.enum(['open', 'ask'])
const sessionStatusSchema = z.enum(['idle', 'running', 'awaiting-approval', 'error'])
const toolIntentSchema = z.enum(['terminal', 'read', 'diff', 'search', 'web', 'generic'])
const toolStatusSchema = z.enum([
  'queued',
  'awaiting-approval',
  'running',
  'success',
  'error',
  'blocked'
])

const conversationNodeSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('user'), text: z.string() }).strict(),
  z
    .object({
      id: z.string(),
      type: z.literal('assistant'),
      markdown: z.string(),
      streaming: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      id: z.string(),
      type: z.literal('think'),
      text: z.string(),
      streaming: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      id: z.string(),
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
      status: toolStatusSchema
    })
    .strict(),
  z.object({ id: z.string(), type: z.literal('error'), message: z.string() }).strict()
])

const projectInfoSchema = z.object({ path: z.string(), name: z.string() }).strict()
const sessionSummarySchema = z
  .object({
    id: z.string(),
    path: z.string(),
    title: z.string(),
    modified: z.string(),
    messageCount: nonNegativeInteger,
    active: z.boolean(),
    status: sessionStatusSchema
  })
  .strict()
const accountSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    authType: z.enum(['api_key', 'oauth']),
    connected: z.boolean(),
    subscription: z.boolean(),
    alias: z.boolean()
  })
  .strict()
const modelSummarySchema = z
  .object({
    provider: z.string(),
    id: z.string(),
    name: z.string(),
    contextWindow: nonNegativeInteger,
    reasoning: z.boolean()
  })
  .strict()
const modelAvailabilitySchema = z.enum(['available', 'unavailable', 'unselected'])
const composeBlockReasonSchema = z
  .enum([
    'project-required',
    'login-required',
    'model-required',
    'model-unavailable',
    'pinned-model-unavailable'
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
    tokensPerSecond: z.number().nonnegative().optional()
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
    detail: z.string()
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
    .object({ action: z.literal('click'), ref: z.string().min(1), ...browserPageTargetShape })
    .strict(),
  ...(['fill', 'select'] as const).map((action) =>
    z
      .object({
        action: z.literal(action),
        ref: z.string().min(1),
        value: z.string(),
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
      text: z.string().min(1).optional(),
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

const agentSnapshotMetaShape = {
  ready: z.boolean(),
  engine: z.literal(AGENT_ENGINE),
  agentDir: z.string(),
  project: projectInfoSchema.nullable(),
  sessions: z.array(sessionSummarySchema),
  activeSessionPath: z.string().nullable(),
  accounts: z.array(accountSummarySchema),
  models: z.array(modelSummarySchema),
  activeProvider: z.string().nullable(),
  activeModel: z.string().nullable(),
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
  loginPrompt: loginPromptSchema.nullable(),
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
const stateGetCommandSchema = z.object({ type: z.literal('state:get') }).strict()
const projectOpenCommandSchema = z
  .object({ type: z.literal('project:open'), cwd: z.string().min(1) })
  .strict()
const sessionNewBareCommandSchema = z.object({ type: z.literal('session:new') }).strict()
const sessionNewExactCommandSchema = z
  .object({
    type: z.literal('session:new'),
    providerId: z.string().min(1),
    modelId: z.string().min(1)
  })
  .strict()
const sessionNewCommandSchema = z.union([sessionNewBareCommandSchema, sessionNewExactCommandSchema])
const sessionOpenCommandSchema = z
  .object({ type: z.literal('session:open'), path: z.string().min(1) })
  .strict()
const promptSendCommandSchema = z
  .object({ type: z.literal('prompt:send'), text: z.string().min(1) })
  .strict()
const promptAbortCommandSchema = z.object({ type: z.literal('prompt:abort') }).strict()
const queueClearCommandSchema = z.object({ type: z.literal('queue:clear') }).strict()
const permissionSetCommandSchema = z
  .object({ type: z.literal('permission:set'), mode: permissionModeSchema })
  .strict()
const permissionRespondCommandSchema = z
  .object({
    type: z.literal('permission:respond'),
    approvalId: z.string().min(1),
    allow: z.boolean()
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

const commandSchemas = [
  bootstrapCommandSchema,
  stateGetCommandSchema,
  projectOpenCommandSchema,
  sessionNewCommandSchema,
  sessionOpenCommandSchema,
  promptSendCommandSchema,
  promptAbortCommandSchema,
  queueClearCommandSchema,
  permissionSetCommandSchema,
  permissionRespondCommandSchema,
  accountLoginCommandSchema,
  accountLoginRespondCommandSchema,
  accountAliasAddCommandSchema,
  modelSetCommandSchema,
  browserE2ECommandSchema
] as const

export const hostCommandSchema: z.ZodType<HostCommand> = z.union(commandSchemas)

const requestIdShape = { requestId: z.string().min(1) }
export const hostRequestSchema: z.ZodType<HostRequest> = z.union([
  bootstrapCommandSchema.extend(requestIdShape),
  stateGetCommandSchema.extend(requestIdShape),
  projectOpenCommandSchema.extend(requestIdShape),
  sessionNewBareCommandSchema.extend(requestIdShape),
  sessionNewExactCommandSchema.extend(requestIdShape),
  sessionOpenCommandSchema.extend(requestIdShape),
  promptSendCommandSchema.extend(requestIdShape),
  promptAbortCommandSchema.extend(requestIdShape),
  queueClearCommandSchema.extend(requestIdShape),
  permissionSetCommandSchema.extend(requestIdShape),
  permissionRespondCommandSchema.extend(requestIdShape),
  accountLoginCommandSchema.extend(requestIdShape),
  accountLoginRespondCommandSchema.extend(requestIdShape),
  accountAliasAddCommandSchema.extend(requestIdShape),
  modelSetCommandSchema.extend(requestIdShape),
  browserE2ECommandSchema.extend(requestIdShape)
])

export const hostResultSchema: z.ZodType<HostResult> = z.discriminatedUnion('kind', [
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
      data: z.object({ url: z.string() }).strict()
    })
    .strict()
])

export const hostMessageSchema: z.ZodType<HostMessage> = z.union([
  hostResponseSchema,
  hostEventSchema
])

export * from './workbench-schemas'
