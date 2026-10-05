import { describe, expect, it, vi } from 'vitest'
import { discoverEndpointModels, modelsUrl } from './endpoint-discovery'
const command = {
  type: 'endpoint:discover',
  baseUrl: 'https://example.com/v1',
  key: 'fixture-secret',
  api: 'openai-completions'
} as const

describe('endpoint model discovery', () => {
  it.each([
    ['https://example.com', 'https://example.com/v1/models'],
    ['https://example.com/v1/', 'https://example.com/v1/models'],
    ['https://example.com/proxy/v1/chat/completions', 'https://example.com/proxy/v1/models'],
    ['http://localhost:1234/v1/models', 'http://localhost:1234/v1/models']
  ])('normalizes %s', (base, expected) => expect(modelsUrl(base)).toBe(expected))
  it('uses bearer auth, refuses redirects, deduplicates and filters invalid IDs', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }, { id: 3 }, { id: '\n' }] })
      )
    expect(await discoverEndpointModels(command, fetcher)).toEqual({
      baseUrl: command.baseUrl,
      modelIds: ['a', 'b'],
      truncated: false
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.com/v1/models',
      expect.objectContaining({
        redirect: 'error',
        headers: { Authorization: 'Bearer fixture-secret' }
      })
    )
  })
  it('uses Anthropic headers and reports incomplete pagination', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ id: 'claude' }], has_more: true }))
    expect(
      await discoverEndpointModels({ ...command, api: 'anthropic-messages' }, fetcher)
    ).toEqual({ baseUrl: command.baseUrl, modelIds: ['claude'], truncated: true })
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({
      'x-api-key': command.key,
      'anthropic-version': '2023-06-01'
    })
  })
  it('keeps a gateway catalog of more than a hundred models', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ data: Array.from({ length: 140 }, (_, i) => ({ id: `model-${i}` })) })
      )
    const result = await discoverEndpointModels(command, fetcher)
    expect(result.modelIds).toHaveLength(140)
    expect(result.truncated).toBe(false)
  })
  it('bounds the returned catalog', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ data: Array.from({ length: 1010 }, (_, i) => ({ id: `model-${i}` })) })
      )
    const result = await discoverEndpointModels(command, fetcher)
    expect(result.modelIds).toHaveLength(1000)
    expect(result.truncated).toBe(true)
  })
  it('does not echo service errors or credentials', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('fixture-secret', { status: 401 }))
    await expect(discoverEndpointModels(command, fetcher)).rejects.toThrow('认证失败')
  })
  it('rejects malformed lists and unsupported addresses', async () => {
    await expect(
      discoverEndpointModels(
        command,
        vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [] }))
      )
    ).rejects.toThrow('未发现')
    const fetcher = vi.fn<typeof fetch>()
    await expect(
      discoverEndpointModels({ ...command, baseUrl: 'http://example.com' }, fetcher)
    ).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
