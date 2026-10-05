import { describe, expect, it } from 'vitest'
import { groupModelsByFamily, modelFamily } from './model-presentation'

describe('model families', () => {
  it('recognizes families with or without a vendor prefix', () => {
    expect(
      [
        'claude-opus-5',
        'anthropic/claude-sonnet-5',
        'gpt-5.5',
        'openai/gpt-4o',
        'o3-mini',
        'gemini-2.5-pro',
        'deepseek-r1-0528',
        'qwen3-coder',
        'moonshotai/kimi-k2',
        'glm-4.6',
        'x-ai/grok-4',
        'meta-llama/llama-4',
        'some-new-model'
      ].map((id) => modelFamily({ id }).id)
    ).toEqual([
      'claude',
      'claude',
      'gpt',
      'gpt',
      'gpt',
      'gemini',
      'deepseek',
      'qwen',
      'kimi',
      'glm',
      'grok',
      'llama',
      'other'
    ])
  })

  it('keeps short or single-family lists flat', () => {
    const few = ['claude-a', 'gpt-b', 'gemini-c'].map((id) => ({ id }))
    expect(groupModelsByFamily(few)).toEqual([{ id: 'all', label: '', models: few }])
    const oneFamily = Array.from({ length: 20 }, (_, i) => ({ id: `claude-${i}` }))
    expect(groupModelsByFamily(oneFamily)).toHaveLength(1)
  })

  it('splits a long gateway list by family, known families first and the rest last', () => {
    const models = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `mystery-${i}` })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `gpt-${i}` })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `anthropic/claude-${i}` }))
    ]
    const groups = groupModelsByFamily(models)
    expect(groups.map((group) => [group.id, group.models.length])).toEqual([
      ['claude', 5],
      ['gpt', 5],
      ['other', 5]
    ])
  })
})
