import { describe, expect, it, vi } from 'vitest'
import type { AccountSummary, ModelSummary } from '../shared/contracts'
import {
  applyExactModelSelection,
  composeBlockReasonForSnapshot,
  completeLoginSuccess,
  createOneShotRecoveryModelSelector,
  prepareNewSessionModelSelection,
  prepareSessionRecoveryModelSelection,
  projectSessionModelPin,
  validateExactModelSelection,
  validateNewSessionModelSelection
} from './session-model'

const connectedAccounts: AccountSummary[] = [
  {
    id: 'openai-codex-work',
    name: 'OpenAI Codex Work',
    authType: 'oauth',
    connected: true,
    subscription: true,
    alias: true
  },
  {
    id: 'openai-codex-personal',
    name: 'OpenAI Codex Personal',
    authType: 'oauth',
    connected: false,
    subscription: true,
    alias: true
  }
]

const availableModels: ModelSummary[] = [
  {
    provider: 'openai-codex-work',
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    contextWindow: 200_000,
    reasoning: true
  },
  {
    provider: 'openai-codex-work',
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    contextWindow: 128_000,
    reasoning: true
  }
]

describe('exact model selection', () => {
  it('uses a recovery model only for the first runtime creation', () => {
    const recovery = {
      identity: { providerId: 'openai-codex-work', modelId: 'gpt-5.6-sol' },
      runtimeModel: { provider: 'openai-codex-work', id: 'gpt-5.6-sol' }
    }
    const nextSession = {
      identity: { providerId: 'openai-codex-work', modelId: 'gpt-5.6-luna' },
      runtimeModel: { provider: 'openai-codex-work', id: 'gpt-5.6-luna' }
    }
    const select = createOneShotRecoveryModelSelector(recovery)

    expect(select(null)).toBe(recovery)
    expect(select(nextSession)).toBe(nextSession)
    expect(select(null)).toBeNull()
  })

  it('accepts only the connected provider and exact available model combination', () => {
    expect(
      validateExactModelSelection(
        connectedAccounts,
        availableModels,
        'openai-codex-work',
        'gpt-5.6-sol'
      )
    ).toEqual({ providerId: 'openai-codex-work', modelId: 'gpt-5.6-sol' })

    expect(() =>
      validateExactModelSelection(
        connectedAccounts,
        availableModels,
        'openai-codex-personal',
        'gpt-5.6-sol'
      )
    ).toThrow('账号 openai-codex-personal 未登录')
    expect(() =>
      validateExactModelSelection(
        connectedAccounts,
        availableModels,
        'openai-codex-work',
        'gpt-5.6-missing'
      )
    ).toThrow('模型 openai-codex-work/gpt-5.6-missing 当前不可用')
  })

  it('allows an unselected new session but rejects partial provider/model input', () => {
    expect(
      validateNewSessionModelSelection(connectedAccounts, availableModels, undefined, undefined)
    ).toBeNull()
    expect(() =>
      validateNewSessionModelSelection(
        connectedAccounts,
        availableModels,
        'openai-codex-work',
        undefined
      )
    ).toThrow('新会话必须同时指定账号和模型')
  })

  it('resolves the exact runtime model before session replacement can begin', () => {
    const runtimeModel = { id: 'runtime-sol' }
    expect(
      prepareNewSessionModelSelection(
        connectedAccounts,
        availableModels,
        'openai-codex-work',
        'gpt-5.6-sol',
        () => runtimeModel
      )
    ).toEqual({
      identity: { providerId: 'openai-codex-work', modelId: 'gpt-5.6-sol' },
      runtimeModel
    })
    expect(() =>
      prepareNewSessionModelSelection(
        connectedAccounts,
        availableModels,
        'openai-codex-work',
        'gpt-5.6-sol',
        () => undefined
      )
    ).toThrow('模型 openai-codex-work/gpt-5.6-sol 当前不可用')
  })
})

describe('model selection transition', () => {
  it('changes the model in place when the existing transcript is stable', async () => {
    const applyModel = vi.fn(async () => undefined)
    const target = {
      sessionId: 'session-a',
      generation: 4,
      busy: false,
      promptPending: false,
      hasTranscript: true
    }

    await expect(
      applyExactModelSelection('openai-codex-work', 'gpt-5.6-sol', {
        readTarget: () => target,
        refreshAuthProjection: async () => undefined,
        getAccounts: () => connectedAccounts,
        getModels: () => availableModels,
        findAvailableModel: () => ({ id: 'runtime-model' }),
        applyModel
      })
    ).resolves.toEqual({
      providerId: 'openai-codex-work',
      modelId: 'gpt-5.6-sol'
    })

    expect(applyModel).toHaveBeenCalledOnce()
  })

  it('refuses to mutate when a prompt adds transcript during auth refresh', async () => {
    const applyModel = vi.fn(async () => undefined)
    let target = {
      sessionId: 'session-a',
      generation: 4,
      busy: false,
      promptPending: false,
      hasTranscript: false
    }

    await expect(
      applyExactModelSelection('openai-codex-work', 'gpt-5.6-sol', {
        readTarget: () => target,
        refreshAuthProjection: async () => {
          target = { ...target, promptPending: true, hasTranscript: true }
        },
        getAccounts: () => connectedAccounts,
        getModels: () => availableModels,
        findAvailableModel: () => ({ id: 'runtime-model' }),
        applyModel
      })
    ).rejects.toThrow('会话内容已变化，请重新选择模型')

    expect(applyModel).not.toHaveBeenCalled()
  })

  it('refuses to mutate when the active session identity changes during auth refresh', async () => {
    const applyModel = vi.fn(async () => undefined)
    let target = {
      sessionId: 'session-a',
      generation: 4,
      busy: false,
      promptPending: false,
      hasTranscript: false
    }

    await expect(
      applyExactModelSelection('openai-codex-work', 'gpt-5.6-sol', {
        readTarget: () => target,
        refreshAuthProjection: async () => {
          target = { ...target, sessionId: 'session-b', generation: 5 }
        },
        getAccounts: () => connectedAccounts,
        getModels: () => availableModels,
        findAvailableModel: () => ({ id: 'runtime-model' }),
        applyModel
      })
    ).rejects.toThrow('会话已切换，请重新选择模型')

    expect(applyModel).not.toHaveBeenCalled()
  })

  it('rechecks prompt activity immediately before applying the runtime model', async () => {
    const applyModel = vi.fn(async () => undefined)
    let target = {
      sessionId: 'session-a',
      generation: 4,
      busy: false,
      promptPending: false,
      hasTranscript: false
    }

    await expect(
      applyExactModelSelection('openai-codex-work', 'gpt-5.6-sol', {
        readTarget: () => target,
        refreshAuthProjection: async () => undefined,
        getAccounts: () => connectedAccounts,
        getModels: () => availableModels,
        findAvailableModel: () => {
          target = { ...target, promptPending: true }
          return { id: 'runtime-model' }
        },
        applyModel
      })
    ).rejects.toThrow('当前会话正在运行，不能切换模型')

    expect(applyModel).not.toHaveBeenCalled()
  })
})

describe('canonical session model projection', () => {
  it('keeps an available selected model unblocked in the host snapshot', () => {
    expect(
      composeBlockReasonForSnapshot(true, {
        composeBlockReason: null
      })
    ).toBeNull()
  })

  it('preserves an explicit empty-session model through runtime recovery', () => {
    const recovery = prepareSessionRecoveryModelSelection(
      { providerId: 'openai-codex-work', modelId: 'gpt-5.6-sol' },
      { provider: 'openai-codex-work', id: 'gpt-5.6-sol' },
      false
    )

    expect(recovery).toEqual({
      identity: { providerId: 'openai-codex-work', modelId: 'gpt-5.6-sol' },
      runtimeModel: { provider: 'openai-codex-work', id: 'gpt-5.6-sol' }
    })
    expect(
      projectSessionModelPin(
        {
          header: { id: 'session-recovered-empty' },
          entries: [
            { type: 'model_change' },
            { type: 'thinking_level_change' },
            { type: 'model_change' }
          ],
          contextModel: {
            provider: recovery!.identity.providerId,
            modelId: recovery!.identity.modelId
          },
          runtimeModel: recovery!.runtimeModel,
          explicitModel: null
        },
        connectedAccounts,
        availableModels
      )
    ).toMatchObject({
      identity: { providerId: 'openai-codex-work', modelId: 'gpt-5.6-sol' },
      pinned: true,
      modelAvailability: 'available',
      composeBlockReason: null
    })
  })

  it('refuses to rebuild an empty explicit session with a fallback runtime model', () => {
    expect(() =>
      prepareSessionRecoveryModelSelection(
        { providerId: 'openai-codex-work', modelId: 'gpt-5.6-sol' },
        { provider: 'openai-codex-work', id: 'gpt-5.6-luna' },
        false
      )
    ).toThrow('当前空会话的显式模型无法安全恢复')
  })

  it('keeps an unavailable canonical pin instead of displaying the SDK fallback', () => {
    const projection = projectSessionModelPin(
      {
        header: { id: 'session-1' },
        entries: [{ type: 'message', message: { role: 'user' } }],
        contextModel: {
          provider: 'openai-codex-personal',
          modelId: 'gpt-5.6-sol'
        },
        runtimeModel: {
          provider: 'openai-codex-work',
          id: 'gpt-5.6-luna'
        },
        explicitModel: null
      },
      connectedAccounts,
      availableModels
    )

    expect(projection).toEqual({
      sessionId: 'session-1',
      identity: {
        providerId: 'openai-codex-personal',
        modelId: 'gpt-5.6-sol'
      },
      pinned: true,
      hasTranscript: true,
      modelAvailability: 'unavailable',
      composeBlockReason: 'pinned-model-unavailable'
    })
  })

  it('recovers a legacy pin from canonical assistant entries when context has no model change', () => {
    const projection = projectSessionModelPin(
      {
        header: { id: 'session-legacy' },
        entries: [
          { type: 'message', message: { role: 'user' } },
          {
            type: 'message',
            message: {
              role: 'assistant',
              provider: 'openai-codex-personal',
              model: 'gpt-5.6-sol'
            }
          }
        ],
        contextModel: null,
        runtimeModel: {
          provider: 'openai-codex-work',
          id: 'gpt-5.6-luna'
        },
        explicitModel: null
      },
      connectedAccounts,
      availableModels
    )

    expect(projection.identity).toEqual({
      providerId: 'openai-codex-personal',
      modelId: 'gpt-5.6-sol'
    })
    expect(projection.pinned).toBe(true)
    expect(projection.modelAvailability).toBe('unavailable')
  })

  it('blocks a canonical pin when the loaded runtime still holds a different fallback', () => {
    const projection = projectSessionModelPin(
      {
        header: { id: 'session-runtime-mismatch' },
        entries: [{ type: 'message', message: { role: 'user' } }],
        contextModel: {
          provider: 'openai-codex-work',
          modelId: 'gpt-5.6-sol'
        },
        runtimeModel: {
          provider: 'openai-codex-work',
          id: 'gpt-5.6-luna'
        },
        explicitModel: null
      },
      connectedAccounts,
      availableModels
    )

    expect(projection.identity).toEqual({
      providerId: 'openai-codex-work',
      modelId: 'gpt-5.6-sol'
    })
    expect(projection.modelAvailability).toBe('unavailable')
    expect(projection.composeBlockReason).toBe('pinned-model-unavailable')
  })

  it('keeps a new session unselected when the SDK has chosen an implicit fallback', () => {
    const projection = projectSessionModelPin(
      {
        header: { id: 'session-2' },
        entries: [{ type: 'model_change' }, { type: 'thinking_level_change' }],
        contextModel: {
          provider: 'openai-codex-work',
          modelId: 'gpt-5.6-sol'
        },
        runtimeModel: {
          provider: 'openai-codex-work',
          id: 'gpt-5.6-sol'
        },
        explicitModel: null
      },
      connectedAccounts,
      availableModels
    )

    expect(projection.identity).toBeNull()
    expect(projection.modelAvailability).toBe('unselected')
    expect(projection.composeBlockReason).toBe('model-required')
  })
})

describe('login success projection', () => {
  it('refreshes auth state and publishes success without selecting a model', async () => {
    const effects = {
      refreshAuthProjection: vi.fn(async () => undefined),
      publishLogin: vi.fn(),
      setModel: vi.fn()
    }

    await completeLoginSuccess('openai-codex-work', effects)

    expect(effects.refreshAuthProjection).toHaveBeenCalledOnce()
    expect(effects.publishLogin).toHaveBeenCalledWith({
      phase: 'success',
      providerId: 'openai-codex-work'
    })
    expect(effects.setModel).not.toHaveBeenCalled()
  })
})
