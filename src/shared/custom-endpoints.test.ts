import { describe, expect, it } from 'vitest'
import { createCustomEndpointSchema, customEndpointSchema } from './custom-endpoints'

const endpoint = {
  label: ' Gateway ',
  api: 'openai-completions',
  baseUrl: 'https://example.com/v1',
  modelIds: [' model-a ']
}

describe('custom endpoint contracts', () => {
  it('normalizes metadata and requires a literal key only when creating', () => {
    expect(customEndpointSchema.parse(endpoint)).toEqual({
      ...endpoint,
      label: 'Gateway',
      modelIds: ['model-a']
    })
    expect(createCustomEndpointSchema.safeParse(endpoint).success).toBe(false)
    expect(createCustomEndpointSchema.parse({ ...endpoint, key: '!$literal' }).key).toBe(
      '!$literal'
    )
    expect(customEndpointSchema.safeParse({ ...endpoint, key: '' }).success).toBe(false)
  })

  it.each([
    'http://example.com',
    'http://127.1',
    'http://2130706433',
    'http://0x7f000001',
    'http://127.0.0.2',
    'http://localhost.',
    'http://[0:0:0:0:0:0:0:1]',
    'ftp://localhost',
    'https://user:secret@example.com',
    'https://@example.com',
    'https:////@example.com',
    'https://example.com?',
    'https://example.com#',
    'https://exam\nple.com',
    'https://example.com\\secret'
  ])('rejects unsafe address %s', (baseUrl) => {
    expect(customEndpointSchema.safeParse({ ...endpoint, baseUrl }).success).toBe(false)
  })
  it.each([
    'https://example.com/v1',
    'http://localhost:8080/v1',
    'http://127.0.0.1/v1',
    'http://[::1]:8000/v1'
  ])('accepts explicit safe address %s', (baseUrl) => {
    expect(customEndpointSchema.safeParse({ ...endpoint, baseUrl }).success).toBe(true)
  })
  it('bounds Unicode labels, trimmed model IDs, protocol, and literal key bytes', () => {
    for (const patch of [
      { label: '' },
      { label: '😀'.repeat(81) },
      { label: 'a\u0000b' },
      { modelIds: [] },
      { modelIds: ['a', ' a '] },
      { modelIds: ['x'.repeat(201)] },
      { modelIds: ['a\tb'] },
      { modelIds: Array.from({ length: 101 }, (_, i) => `m${i}`) },
      { api: 'unknown' },
      { key: '😀'.repeat(4097) },
      { key: '   ' },
      { headers: {} }
    ])
      expect(customEndpointSchema.safeParse({ ...endpoint, ...patch }).success).toBe(false)
    expect(
      customEndpointSchema.safeParse({
        ...endpoint,
        label: '😀'.repeat(80),
        modelIds: ['x'.repeat(200)],
        key: '😀'.repeat(4096)
      }).success
    ).toBe(true)
  })
})
