import { describe, expect, it } from 'vitest'
import {
  assistantTerminalNode,
  measuredGenerationSpeed,
  ModelRejections,
  projectRunStatus
} from './assistant-outcome'
import { validateExactModelSelection, projectSessionModelPin } from './session-model'

describe('canonical assistant outcomes', () => {
  it('keeps an auto-retrying run active and makes explicit cancellation neutral', () => {
    expect(
      projectRunStatus({
        busy: true,
        awaitingApproval: false,
        stopped: false,
        error: 'fetch failed'
      })
    ).toBe('running')
    expect(
      projectRunStatus({
        busy: false,
        awaitingApproval: false,
        stopped: true,
        error: 'fetch failed'
      })
    ).toBe('stopped')
    expect(
      projectRunStatus({
        busy: false,
        awaitingApproval: false,
        stopped: false,
        error: 'fetch failed'
      })
    ).toBe('error')
  })
  it('keeps cancellation independent of provider error wording', () => {
    expect(
      assistantTerminalNode({
        timestamp: 1,
        stopReason: 'aborted',
        errorMessage: 'Request was aborted'
      })
    ).toEqual({ id: 'stopped-1', type: 'stopped', message: '已停止生成，可继续对话' })
    expect(
      assistantTerminalNode({
        timestamp: 1,
        stopReason: 'error',
        errorMessage: 'Request was aborted'
      })?.type
    ).toBe('error')
    expect(assistantTerminalNode({ timestamp: 1, stopReason: 'stop' })).toBeNull()
  })
  it('does not calculate zero throughput from missing aborted usage', () => {
    expect(
      measuredGenerationSpeed({ llmDurationMs: 2000, outputTokens: 0, usageIncomplete: true })
    ).toBeUndefined()
    expect(
      measuredGenerationSpeed({ llmDurationMs: 2000, outputTokens: 10, usageIncomplete: true })
    ).toBeUndefined()
    expect(measuredGenerationSpeed({ llmDurationMs: 2000, outputTokens: 10 })).toBe(5)
    expect(measuredGenerationSpeed({ llmDurationMs: 0, outputTokens: 10 })).toBeUndefined()
  })
})

describe('account-scoped model rejection', () => {
  const model = {
    provider: 'openai-codex-work',
    id: 'gpt-test',
    name: 'Test',
    reasoning: true,
    contextWindow: 128000
  }
  const account = {
    id: model.provider,
    name: 'Work',
    authType: 'oauth' as const,
    connected: true,
    subscription: true,
    alias: true
  }
  const rejection = {
    provider: model.provider,
    model: model.id,
    stopReason: 'error',
    errorMessage:
      "Codex error: The 'gpt-test' model is not supported when using Codex with a ChatGPT account."
  }
  it('blocks exact selection and sending without mutating the pinned identity or another account', () => {
    const registry = new ModelRejections()
    registry.record(rejection)
    const blocked = registry.project(model)
    expect(blocked.unavailableReason).toContain('当前 ChatGPT 账号不支持')
    expect(
      registry.project({ ...model, provider: 'openai-codex-home' }).unavailableReason
    ).toBeUndefined()
    expect(() =>
      validateExactModelSelection([account], [blocked], model.provider, model.id)
    ).toThrow('不可用')
    const pin = projectSessionModelPin(
      {
        header: { id: 'same-session' },
        entries: [{ type: 'message' }],
        contextModel: { provider: model.provider, modelId: model.id },
        explicitModel: null
      },
      [account],
      [blocked]
    )
    expect(pin.modelAvailability).toBe('unavailable')
    expect(pin.identity).toEqual({ providerId: model.provider, modelId: model.id })
    registry.clear('openai-codex-home')
    expect(registry.project(model).unavailableReason).toBeDefined()
    registry.clear(model.provider)
    expect(registry.project(model).unavailableReason).toBeUndefined()
  })
  it('does not disable models for network errors, rate limits, cancellation or another model name', () => {
    const registry = new ModelRejections()
    registry.record({ ...rejection, errorMessage: '429 rate limit' })
    registry.record({ ...rejection, errorMessage: 'Network connection failed' })
    registry.record({ ...rejection, stopReason: 'aborted' })
    registry.record({ ...rejection, model: 'different-model' })
    expect(registry.project(model).unavailableReason).toBeUndefined()
  })
})
