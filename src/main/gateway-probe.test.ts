import { describe, expect, it } from 'vitest'
import { probeGateway } from './gateway-probe'
import { gatewayEngines } from '../shared/gateway'

type Route = (init: RequestInit & { headers: Record<string, string> }) => {
  status: number
  body?: unknown
  html?: boolean
}

/** A fake gateway: routes by method and URL; anything else is a 404. */
function gateway(routes: Record<string, Route>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetcher = (async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
    const method = init.method ?? 'GET'
    calls.push(`${method} ${url}`)
    const route = routes[`${method} ${url}`]
    const answer = route ? route(init) : { status: 404, body: { error: 'not found' } }
    return new Response(
      answer.html ? '<!doctype html><title>Gateway</title>' : JSON.stringify(answer.body ?? {}),
      {
        status: answer.status,
        headers: { 'content-type': answer.html ? 'text/html' : 'application/json' }
      }
    )
  }) as unknown as typeof fetch
  return { fetch: fetcher, calls }
}

const models = { status: 200, body: { data: [{ id: 'gpt-5' }, { id: 'claude-sonnet' }] } }
const refused = { status: 400, body: { error: { message: 'model is required' } } }

describe('probeGateway', () => {
  it('finds both APIs of a one-key gateway, whatever path the user typed', async () => {
    const { fetch } = gateway({
      'GET https://gw.example.com/v1/models': () => models,
      'POST https://gw.example.com/v1/chat/completions': () => refused,
      'POST https://gw.example.com/v1/responses': () => refused,
      'POST https://gw.example.com/v1/messages': ({ headers }) =>
        headers['x-api-key'] === 'k' ? refused : { status: 401 }
    })
    for (const baseUrl of ['https://gw.example.com', 'https://gw.example.com/v1/']) {
      const probe = await probeGateway({ baseUrl, key: 'k' }, fetch)
      expect(probe).toEqual({
        openai: { baseUrl: 'https://gw.example.com/v1', chat: true, responses: true },
        anthropic: { baseUrl: 'https://gw.example.com', auth: 'x-api-key' },
        modelIds: ['gpt-5', 'claude-sonnet'],
        truncated: false
      })
      expect(gatewayEngines(probe)).toEqual({ pi: true, claude: true, codex: true })
    }
  })

  it('learns that the Anthropic route wants a bearer token, at /anthropic', async () => {
    const { fetch } = gateway({
      'GET https://api.deepseek.test/v1/models': () => models,
      'POST https://api.deepseek.test/v1/chat/completions': () => refused,
      'POST https://api.deepseek.test/anthropic/v1/messages': ({ headers }) =>
        headers.Authorization === 'Bearer k' ? refused : { status: 401, body: {} }
    })
    const probe = await probeGateway({ baseUrl: 'https://api.deepseek.test/v1', key: 'k' }, fetch)
    expect(probe.openai).toEqual({
      baseUrl: 'https://api.deepseek.test/v1',
      chat: true,
      responses: false
    })
    expect(probe.anthropic).toEqual({
      baseUrl: 'https://api.deepseek.test/anthropic',
      auth: 'bearer'
    })
    expect(gatewayEngines(probe)).toEqual({ pi: true, claude: true, codex: false })
  })

  it('does not take a web page or a refused key for a working route', async () => {
    const { fetch } = gateway({
      'GET https://only-openai.test/v1/models': () => models,
      'POST https://only-openai.test/v1/chat/completions': () => refused,
      'POST https://only-openai.test/v1/responses': () => ({ status: 200, html: true }),
      'POST https://only-openai.test/v1/messages': () => ({ status: 401 })
    })
    const probe = await probeGateway({ baseUrl: 'https://only-openai.test/v1', key: 'k' }, fetch)
    expect(probe.openai?.responses).toBe(false)
    expect(probe.anthropic).toBeNull()
    expect(gatewayEngines(probe)).toEqual({ pi: true, claude: false, codex: false })
  })

  it('reads the models of an Anthropic-only service and reports a dead address', async () => {
    const { fetch } = gateway({
      'POST https://claude-only.test/v1/messages': () => refused,
      'GET https://claude-only.test/v1/models': ({ headers }) =>
        headers['x-api-key'] === 'k'
          ? { status: 200, body: { data: [{ id: 'claude-x' }] } }
          : { status: 401 }
    })
    const probe = await probeGateway({ baseUrl: 'https://claude-only.test', key: 'k' }, fetch)
    expect(probe.openai).toBeNull()
    expect(probe.anthropic).toEqual({ baseUrl: 'https://claude-only.test', auth: 'x-api-key' })
    expect(probe.modelIds).toEqual(['claude-x'])

    await expect(
      probeGateway({ baseUrl: 'https://nothing.test', key: 'k' }, gateway({}).fetch)
    ).rejects.toThrow()
  })
})
