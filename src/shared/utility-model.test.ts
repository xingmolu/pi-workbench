import { describe, expect, it } from 'vitest'
import { cleanGeneratedLine, parseUtilityModel, utilityModelCandidates } from './utility-model'

const model = (provider: string, id: string): { provider: string; id: string } => ({
  provider,
  id
})

describe('utility model candidates', () => {
  const available = [
    model('anthropic', 'claude-opus-5-5'),
    model('anthropic', 'claude-haiku-4-5'),
    model('openai-codex', 'gpt-5.4'),
    model('openai-codex', 'gpt-5.4-mini'),
    model('google', 'gemini-3-flash'),
    model('deepseek', 'deepseek-chat')
  ]

  it('tries the user choice, then two small defaults, then the session model', () => {
    expect(
      utilityModelCandidates(available, {
        preferred: [{ providerId: 'deepseek', modelId: 'deepseek-chat' }],
        fallback: { providerId: 'anthropic', modelId: 'claude-opus-5-5' }
      })
    ).toEqual([
      { providerId: 'deepseek', modelId: 'deepseek-chat' },
      { providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
      { providerId: 'openai-codex', modelId: 'gpt-5.4-mini' },
      { providerId: 'anthropic', modelId: 'claude-opus-5-5' }
    ])
  })

  it('skips a choice or fallback that is not available now, and repeats nothing', () => {
    expect(
      utilityModelCandidates(available, {
        preferred: [
          { providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
          { providerId: 'gone', modelId: 'model' }
        ],
        fallback: { providerId: 'anthropic', modelId: 'claude-haiku-4-5' }
      })
    ).toEqual([
      { providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
      { providerId: 'openai-codex', modelId: 'gpt-5.4-mini' },
      { providerId: 'google', modelId: 'gemini-3-flash' }
    ])
  })

  it('passes over image, audio and reasoning variants of a small model', () => {
    expect(
      utilityModelCandidates(
        [
          model('google', 'gemini-3-flash-image'),
          model('openai', 'gpt-5.4-mini-realtime'),
          model('deepseek', 'deepseek-reasoner'),
          model('deepseek', 'deepseek-v4')
        ],
        { preferred: [] }
      )
    ).toEqual([{ providerId: 'deepseek', modelId: 'deepseek-v4' }])
  })

  it('falls back to the session model alone when no small model is connected', () => {
    expect(
      utilityModelCandidates([model('gateway', 'big-model')], {
        preferred: [],
        fallback: { providerId: 'gateway', modelId: 'big-model' }
      })
    ).toEqual([{ providerId: 'gateway', modelId: 'big-model' }])
    expect(utilityModelCandidates([model('gateway', 'big-model')], { preferred: [] })).toEqual([])
  })
})

describe('parseUtilityModel', () => {
  it('splits at the first slash, so model ids may contain slashes', () => {
    expect(parseUtilityModel('openrouter/anthropic/claude-haiku-4.5')).toEqual({
      providerId: 'openrouter',
      modelId: 'anthropic/claude-haiku-4.5'
    })
  })

  it('reads an unset or malformed value as no choice', () => {
    expect(parseUtilityModel(null)).toBeNull()
    expect(parseUtilityModel('no-slash')).toBeNull()
    expect(parseUtilityModel('/model')).toBeNull()
    expect(parseUtilityModel('provider/')).toBeNull()
  })
})

describe('cleanGeneratedLine', () => {
  it('keeps the first line without quotes, prefixes or trailing punctuation', () => {
    expect(cleanGeneratedLine('"Fix login redirect loop."\nBecause…')).toBe(
      'Fix login redirect loop'
    )
    // i18n-ignore: model output in a test
    expect(cleanGeneratedLine('标题：「修复登录跳转」。')).toBe('修复登录跳转')
    expect(cleanGeneratedLine('\n\n# Title: Add CSV export\n')).toBe('Add CSV export')
  })

  it('cuts long answers by characters, not bytes', () => {
    expect([...cleanGeneratedLine('字'.repeat(100), 20)]).toHaveLength(20)
  })

  it('returns nothing usable for an empty answer', () => {
    expect(cleanGeneratedLine('  \n "" \n')).toBe('')
  })
})
