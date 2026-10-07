import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import type { UtilityCompleteCommand } from '../shared/utility-model'
import { runUtilityCompletion, type UtilityModelRuntime } from './utility-completion'

function model(provider: string, id: string): Model<string> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider,
    baseUrl: 'https://example.test',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 300
  } as Model<string>
}

function answer(
  text: string,
  stopReason: AssistantMessage['stopReason'] = 'stop'
): AssistantMessage {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    api: 'openai-completions',
    provider: 'p',
    model: 'm',
    usage: {} as AssistantMessage['usage'],
    stopReason,
    ...(stopReason === 'error' ? { errorMessage: 'quota exceeded' } : {}),
    timestamp: 0
  }
}

const request: UtilityCompleteCommand = {
  type: 'utility:complete',
  system: 'Name it',
  prompt: 'Fix the login redirect',
  maxTokens: 1000,
  preferred: [],
  fallback: { providerId: 'gateway', modelId: 'big' }
}

describe('runUtilityCompletion', () => {
  const available = [model('anthropic', 'claude-haiku-4-5'), model('gateway', 'big')]

  it('asks the small model first, with the prompt and a bounded token budget', async () => {
    const calls: { model: string; options: unknown; context: unknown }[] = []
    const runtime: UtilityModelRuntime = {
      completeSimple: async (target, context, options) => {
        calls.push({ model: target.id, context, options })
        return answer('  Fix login redirect  ')
      }
    }
    await expect(runUtilityCompletion(runtime, available, request)).resolves.toEqual({
      text: 'Fix login redirect',
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5'
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      model: 'claude-haiku-4-5',
      context: {
        systemPrompt: 'Name it',
        messages: [{ role: 'user', content: 'Fix the login redirect' }]
      },
      // The model's own output limit wins over a larger request.
      options: { maxTokens: 300, maxRetries: 0 }
    })
  })

  it('falls through a failing, erroring or empty model to the next one', async () => {
    for (const first of [
      () => Promise.reject(new Error('401')),
      () => Promise.resolve(answer('', 'error')),
      () => Promise.resolve(answer(''))
    ]) {
      const tried: string[] = []
      const runtime: UtilityModelRuntime = {
        completeSimple: async (target) => {
          tried.push(target.id)
          return target.id === 'big' ? answer('From the session model') : first()
        }
      }
      await expect(runUtilityCompletion(runtime, available, request)).resolves.toMatchObject({
        text: 'From the session model',
        modelId: 'big'
      })
      expect(tried).toEqual(['claude-haiku-4-5', 'big'])
    }
  })

  it('reports the last failure when every model fails', async () => {
    const runtime: UtilityModelRuntime = {
      completeSimple: async () => answer('', 'error')
    }
    await expect(runUtilityCompletion(runtime, available, request)).rejects.toThrow(
      /quota exceeded/
    )
  })

  it('gives up on a model that does not answer in time', async () => {
    const tried: string[] = []
    const runtime: UtilityModelRuntime = {
      completeSimple: (target, _context, options) => {
        tried.push(target.id)
        if (target.id === 'big') return Promise.resolve(answer('Late but fine'))
        return new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(new Error('timed out')))
        )
      }
    }
    await expect(
      runUtilityCompletion(runtime, available, request, { attemptTimeoutMs: 20 })
    ).resolves.toMatchObject({ modelId: 'big' })
    expect(tried).toEqual(['claude-haiku-4-5', 'big'])
  })

  it('says how to connect a model when none is available', async () => {
    const runtime: UtilityModelRuntime = { completeSimple: async () => answer('x') }
    await expect(
      runUtilityCompletion(runtime, [], { ...request, fallback: undefined })
    ).rejects.toThrow(/没有可用于生成的模型/)
  })
})
