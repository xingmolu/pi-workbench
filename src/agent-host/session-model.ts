import type {
  AccountSummary,
  ComposeBlockReason,
  LoginStatus,
  ModelAvailability,
  ModelSummary
} from '../shared/contracts'

export type ExactModelSelection = {
  providerId: string
  modelId: string
}

export type PreparedModelSelection<RuntimeModel> = {
  identity: ExactModelSelection
  runtimeModel: RuntimeModel
}

export function createOneShotRecoveryModelSelector<RuntimeModel>(
  recoveryModel: PreparedModelSelection<RuntimeModel> | null
): (
  emptySessionSelection: PreparedModelSelection<RuntimeModel> | null
) => PreparedModelSelection<RuntimeModel> | null {
  let initialRecoveryModel = recoveryModel
  return (emptySessionSelection) => {
    const selected = initialRecoveryModel ?? emptySessionSelection
    initialRecoveryModel = null
    return selected
  }
}

type CanonicalEntry = {
  type: string
  message?: { role?: string; provider?: string; model?: string }
}

type CanonicalSessionModelInput = {
  header: { id: string } | null
  entries: readonly CanonicalEntry[]
  contextModel: { provider: string; modelId: string } | null
  runtimeModel?: { provider: string; id: string } | null
  explicitModel: ExactModelSelection | null
}

export type SessionModelProjection = {
  sessionId: string | null
  identity: ExactModelSelection | null
  pinned: boolean
  hasTranscript: boolean
  modelAvailability: ModelAvailability
  composeBlockReason: ComposeBlockReason
}

export function composeBlockReasonForSnapshot(
  projectSelected: boolean,
  projection: Pick<SessionModelProjection, 'composeBlockReason'> | null
): ComposeBlockReason {
  if (!projectSelected) return 'project-required'
  return projection ? projection.composeBlockReason : 'model-required'
}

function modelIsAvailable(
  accounts: readonly AccountSummary[],
  models: readonly ModelSummary[],
  identity: ExactModelSelection
): boolean {
  return (
    accounts.some((account) => account.id === identity.providerId && account.connected) &&
    models.some((model) => model.provider === identity.providerId && model.id === identity.modelId)
  )
}

export function validateExactModelSelection(
  accounts: readonly AccountSummary[],
  models: readonly ModelSummary[],
  providerId: string,
  modelId: string
): ExactModelSelection {
  const account = accounts.find((item) => item.id === providerId)
  if (!account?.connected) throw new Error(`账号 ${providerId} 未登录`)
  if (!models.some((model) => model.provider === providerId && model.id === modelId)) {
    throw new Error(`模型 ${providerId}/${modelId} 当前不可用`)
  }
  return { providerId, modelId }
}

export function validateNewSessionModelSelection(
  accounts: readonly AccountSummary[],
  models: readonly ModelSummary[],
  providerId?: string,
  modelId?: string
): ExactModelSelection | null {
  if ((providerId && !modelId) || (!providerId && modelId)) {
    throw new Error('新会话必须同时指定账号和模型')
  }
  return providerId && modelId
    ? validateExactModelSelection(accounts, models, providerId, modelId)
    : null
}

export function prepareNewSessionModelSelection<RuntimeModel>(
  accounts: readonly AccountSummary[],
  models: readonly ModelSummary[],
  providerId: string | undefined,
  modelId: string | undefined,
  findAvailableModel: (selection: ExactModelSelection) => RuntimeModel | undefined
): PreparedModelSelection<RuntimeModel> | null {
  const identity = validateNewSessionModelSelection(accounts, models, providerId, modelId)
  if (!identity) return null
  const runtimeModel = findAvailableModel(identity)
  if (!runtimeModel) {
    throw new Error(`模型 ${identity.providerId}/${identity.modelId} 当前不可用`)
  }
  return { identity, runtimeModel }
}

export function prepareSessionRecoveryModelSelection<
  RuntimeModel extends { provider: string; id: string }
>(
  explicitModel: ExactModelSelection | null,
  runtimeModel: RuntimeModel | null,
  hasTranscript: boolean
): PreparedModelSelection<RuntimeModel> | null {
  if (!explicitModel) return null
  if (
    runtimeModel?.provider === explicitModel.providerId &&
    runtimeModel.id === explicitModel.modelId
  ) {
    return { identity: explicitModel, runtimeModel }
  }
  if (!hasTranscript) {
    throw new Error('当前空会话的显式模型无法安全恢复，请重新选择工作区')
  }
  return null
}

export type SessionModelMutationTarget = {
  sessionId: string
  generation: number
  busy: boolean
  promptPending: boolean
  hasTranscript: boolean
}

function requireSameMutableTarget(
  target: SessionModelMutationTarget | null,
  expected: Pick<SessionModelMutationTarget, 'sessionId' | 'generation'>
): SessionModelMutationTarget {
  if (
    !target ||
    target.sessionId !== expected.sessionId ||
    target.generation !== expected.generation
  ) {
    throw new Error('会话已切换，请重新选择模型')
  }
  if (target.hasTranscript) throw new Error('当前会话已有对话内容，不能原地切换模型')
  if (target.busy || target.promptPending) throw new Error('当前会话正在运行，不能切换模型')
  return target
}

export async function applyExactModelSelection<RuntimeModel>(
  providerId: string,
  modelId: string,
  operations: {
    readTarget: () => SessionModelMutationTarget | null
    refreshAuthProjection: () => Promise<void>
    getAccounts: () => readonly AccountSummary[]
    getModels: () => readonly ModelSummary[]
    findAvailableModel: (selection: ExactModelSelection) => RuntimeModel | undefined
    applyModel: (
      target: SessionModelMutationTarget,
      model: RuntimeModel,
      selection: ExactModelSelection
    ) => Promise<void>
  }
): Promise<ExactModelSelection> {
  const beforeRefresh = operations.readTarget()
  if (!beforeRefresh) throw new Error('请先选择工作区')

  await operations.refreshAuthProjection()

  requireSameMutableTarget(operations.readTarget(), beforeRefresh)

  const selection = validateExactModelSelection(
    operations.getAccounts(),
    operations.getModels(),
    providerId,
    modelId
  )
  const model = operations.findAvailableModel(selection)
  if (!model) throw new Error(`模型 ${providerId}/${modelId} 当前不可用`)

  const finalTarget = requireSameMutableTarget(operations.readTarget(), beforeRefresh)
  await operations.applyModel(finalTarget, model, selection)
  return selection
}

export function hasPersistentTranscript(entries: readonly CanonicalEntry[]): boolean {
  return entries.some((entry) =>
    ['message', 'custom_message', 'compaction', 'branch_summary'].includes(entry.type)
  )
}

export function projectSessionModelPin(
  input: CanonicalSessionModelInput,
  accounts: readonly AccountSummary[],
  models: readonly ModelSummary[]
): SessionModelProjection {
  const hasTranscript = hasPersistentTranscript(input.entries)
  const hasExplicitEmptyPin =
    input.entries.filter((entry) => entry.type === 'model_change').length > 1
  const canonicalPinIsExplicit = hasTranscript || hasExplicitEmptyPin
  const legacyAssistant = [...input.entries]
    .reverse()
    .find(
      (entry) =>
        entry.type === 'message' &&
        entry.message?.role === 'assistant' &&
        entry.message.provider &&
        entry.message.model
    )?.message
  const pinnedIdentity =
    input.contextModel && canonicalPinIsExplicit
      ? {
          providerId: input.contextModel.provider,
          modelId: input.contextModel.modelId
        }
      : legacyAssistant?.provider && legacyAssistant.model
        ? {
            providerId: legacyAssistant.provider,
            modelId: legacyAssistant.model
          }
        : null
  const identity = pinnedIdentity ?? input.explicitModel

  if (!identity) {
    return {
      sessionId: input.header?.id ?? null,
      identity: null,
      pinned: false,
      hasTranscript,
      modelAvailability: 'unselected',
      composeBlockReason: accounts.some((account) => account.connected)
        ? 'model-required'
        : 'login-required'
    }
  }

  const runtimeMatches =
    input.runtimeModel === undefined ||
    (input.runtimeModel?.provider === identity.providerId &&
      input.runtimeModel.id === identity.modelId)
  const available = modelIsAvailable(accounts, models, identity) && runtimeMatches
  return {
    sessionId: input.header?.id ?? null,
    identity,
    pinned: Boolean(pinnedIdentity),
    hasTranscript,
    modelAvailability: available ? 'available' : 'unavailable',
    composeBlockReason: available
      ? null
      : pinnedIdentity
        ? 'pinned-model-unavailable'
        : accounts.some((account) => account.id === identity.providerId && account.connected)
          ? 'model-unavailable'
          : 'login-required'
  }
}

export async function completeLoginSuccess(
  providerId: string,
  effects: {
    refreshAuthProjection: () => Promise<void>
    publishLogin: (login: LoginStatus) => void
  }
): Promise<void> {
  await effects.refreshAuthProjection()
  effects.publishLogin({ phase: 'success', providerId })
}
