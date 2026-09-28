import { afterEach, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer as SdkServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { LoopbackCallback, McpAuthRequired, McpOAuthProvider, McpTokenStore } from './mcp-oauth'
import { McpLogins } from './mcp-login'
import { guardedFetch, McpRuntime, usesOAuth } from './mcp-runtime'
import { mcpServerSchema } from '../shared/mcp'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})
async function store(): Promise<McpTokenStore> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-mcp-oauth-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return new McpTokenStore(join(dir, 'mcp-oauth.json'))
}
const until = async (check: () => boolean | Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('condition not reached')
}

/** A fake MCP server behind OAuth: discovery, dynamic registration, token and one tool. */
async function oauthServer(): Promise<{
  origin: string
  seen: { path: string; apiKey?: string; authorization?: string }[]
  registrations: () => number
}> {
  const seen: { path: string; apiKey?: string; authorization?: string }[] = []
  let registrations = 0
  const body = async (request: IncomingMessage): Promise<string> => {
    let text = ''
    for await (const chunk of request) text += chunk
    return text
  }
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url!, origin)
    seen.push({
      path: url.pathname,
      apiKey: request.headers['x-api-key'] as string | undefined,
      authorization: request.headers.authorization
    })
    const json = (value: unknown, status = 200): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
      return json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256']
      })
    if (url.pathname === '/register') {
      registrations++
      const metadata = JSON.parse(await body(request))
      return json({ ...metadata, client_id: `client-${registrations}` }, 201)
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(await body(request))
      if (form.get('code') !== 'good-code' && form.get('grant_type') !== 'refresh_token')
        return json({ error: 'invalid_grant' }, 400)
      return json({ access_token: 'token-1', token_type: 'Bearer', refresh_token: 'refresh-1' })
    }
    if (url.pathname === '/mcp') {
      if (request.headers.authorization !== 'Bearer token-1') {
        response.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`
        })
        return response.end()
      }
      const mcp = new SdkServer({ name: 'fixture', version: '1.0.0' })
      mcp.registerTool('echo', { description: 'echo' }, async () => ({
        content: [{ type: 'text', text: 'ok' }]
      }))
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      })
      await mcp.connect(transport)
      await transport.handleRequest(request, response)
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const origin = `http://127.0.0.1:${address.port}`
  cleanup.push(() => new Promise((resolve) => server.close(resolve)))
  return { origin, seen, registrations: () => registrations }
}

it('keeps tokens owner-only and scoped to one server name at one URL', async () => {
  const tokens = await store()
  const key = McpTokenStore.key('docs', 'https://a.example/mcp')
  expect(key).not.toBe(McpTokenStore.key('docs', 'https://b.example/mcp'))
  await tokens.update(key, () => ({
    tokens: { access_token: 'a', token_type: 'Bearer' },
    updatedAt: ''
  }))
  expect((await stat(tokens.path)).mode & 0o777).toBe(0o600)
  expect((await tokens.get(key))?.tokens?.access_token).toBe('a')
  await tokens.update(key, () => undefined)
  expect(await tokens.get(key)).toBeUndefined()
})

it('never registers or starts an authorization without an explicit login', async () => {
  const tokens = await store()
  const provider = new McpOAuthProvider(tokens, 'docs:1', {})
  await expect(provider.clientInformation()).rejects.toBeInstanceOf(McpAuthRequired)
  await expect(provider.saveCodeVerifier('verifier')).rejects.toBeInstanceOf(McpAuthRequired)
  await expect(provider.redirectToAuthorization(new URL('https://a.example'))).rejects.toThrow()
  expect(provider.required).toBe(true)
  expect(await tokens.get('docs:1')).toBeUndefined()
})

it('registers again when the stored client cannot receive this login redirect', async () => {
  const tokens = await store()
  await tokens.update('docs:1', () => ({
    client: { client_id: 'old', redirect_uris: ['http://127.0.0.1:1111/callback'] },
    updatedAt: ''
  }))
  const login = (redirect: string): McpOAuthProvider =>
    new McpOAuthProvider(tokens, 'docs:1', {}, { redirect, state: 's', open: () => {} })
  expect(await login('http://127.0.0.1:2222/callback').clientInformation()).toBeUndefined()
  expect((await login('http://127.0.0.1:1111/callback').clientInformation())?.client_id).toBe('old')
  const preset = new McpOAuthProvider(tokens, 'docs:1', { clientId: 'preset' })
  expect((await preset.clientInformation())?.client_id).toBe('preset')
})

it('accepts exactly one loopback callback carrying the expected state', async () => {
  const callback = new LoopbackCallback('expected')
  const url = await callback.listen()
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  const wrong = await fetch(`${url}?code=c&state=other`)
  expect(wrong.status).toBe(400)
  await expect(callback.code).rejects.toThrow('授权回调无效')

  const second = new LoopbackCallback('expected')
  const next = await second.listen()
  expect((await fetch(`${next}?code=c&state=expected`)).status).toBe(200)
  await expect(second.code).resolves.toBe('c')
  await expect(fetch(`${next}?code=d&state=expected`)).rejects.toThrow()
})

it('sends configured headers only to the MCP URL and refuses insecure or redirected requests', async () => {
  const fixture = await oauthServer()
  const guarded = guardedFetch({ url: `${fixture.origin}/mcp`, headers: { 'X-Api-Key': 'k' } })
  await guarded(`${fixture.origin}/mcp`, { headers: { 'X-Api-Key': 'k' } })
  await guarded(`${fixture.origin}/.well-known/oauth-authorization-server`, {
    headers: { 'X-Api-Key': 'k', Accept: 'application/json' }
  })
  expect(fixture.seen.map((entry) => entry.apiKey)).toEqual(['k', undefined])
  await expect(guarded('http://example.com/token')).rejects.toThrow('不允许')
  await expect(guarded('https://user:pass@example.com/token')).rejects.toThrow('不允许')
  expect(usesOAuth({ url: 'https://a.example/mcp', headers: { authorization: 'Bearer x' } })).toBe(
    false
  )
  expect(usesOAuth({ url: 'https://a.example/mcp', headers: { 'X-Api-Key': 'x' } })).toBe(true)
})

it('validates OAuth settings as HTTP-only and a secret as belonging to a client ID', () => {
  expect(
    mcpServerSchema.safeParse({ url: 'https://a.example/mcp', oauth: { scope: 'read' } }).success
  ).toBe(true)
  expect(mcpServerSchema.safeParse({ command: 'node', oauth: {} }).success).toBe(false)
  expect(
    mcpServerSchema.safeParse({ url: 'https://a.example/mcp', oauth: { clientSecret: 's' } })
      .success
  ).toBe(false)
  expect(
    mcpServerSchema.safeParse({ url: 'https://a.example/mcp', oauth: { redirectPort: 80 } }).success
  ).toBe(false)
})

it('signs in through the browser, then connects with the stored token and signs out again', async () => {
  const fixture = await oauthServer()
  const tokens = await store()
  const config = { url: `${fixture.origin}/mcp`, headers: { 'X-Api-Key': 'k' }, timeout: 5000 }
  const runtime = new McpRuntime(
    { docs: config },
    '/fixture',
    async () => true,
    async () => true,
    async () => () => {},
    tokens
  )
  cleanup.push(() => runtime.close())
  expect(await runtime.reload({ docs: config })).toBe(false)
  expect(runtime.status('docs')).toMatchObject({ status: 'needs-auth' })
  expect(fixture.registrations()).toBe(0)

  const opened: string[] = []
  const logins = new McpLogins(tokens, (url) => opened.push(url))
  cleanup.push(async () => logins.close())
  logins.start('docs', config, () => runtime.reconnect('docs'))
  expect(logins.state('docs')).toEqual({ status: 'authorizing' })
  await until(() => opened.length === 1)
  const authorize = new URL(opened[0])
  expect(authorize.origin + authorize.pathname).toBe(`${fixture.origin}/authorize`)
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
  const redirect = new URL(authorize.searchParams.get('redirect_uri')!)
  redirect.searchParams.set('code', 'good-code')
  redirect.searchParams.set('state', authorize.searchParams.get('state')!)
  expect((await fetch(redirect)).status).toBe(200)

  await until(
    () => logins.state('docs') === undefined && runtime.status('docs').status === 'connected'
  )
  expect(runtime.status('docs')).toMatchObject({ status: 'connected', toolCount: 1 })
  expect(await logins.authorized('docs', config.url)).toBe(true)
  expect((await tokens.get(McpTokenStore.key('docs', config.url)))?.verifier).toBeUndefined()
  for (const entry of fixture.seen)
    expect(entry.apiKey).toBe(entry.path === '/mcp' ? 'k' : undefined)

  await logins.logout('docs', config.url)
  expect(await runtime.reconnect('docs')).toBe(false)
  expect(runtime.status('docs')).toMatchObject({ status: 'needs-auth' })
})

it('reports a denied authorization without exposing upstream details', async () => {
  const fixture = await oauthServer()
  const tokens = await store()
  const opened: string[] = []
  const logins = new McpLogins(tokens, (url) => opened.push(url))
  cleanup.push(async () => logins.close())
  logins.start('docs', { url: `${fixture.origin}/mcp` }, async () => {})
  await until(() => opened.length === 1)
  const authorize = new URL(opened[0])
  const redirect = new URL(authorize.searchParams.get('redirect_uri')!)
  redirect.searchParams.set('error', 'access_denied')
  redirect.searchParams.set('state', authorize.searchParams.get('state')!)
  expect((await fetch(redirect)).status).toBe(400)
  await until(() => logins.state('docs')?.status === 'failed')
  expect(logins.state('docs')).toEqual({ status: 'failed', message: '授权被拒绝。' })
})
