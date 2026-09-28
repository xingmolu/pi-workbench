import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { McpServer } from '../shared/mcp'

/** What is kept per server: tokens, the registered client and the in-flight PKCE verifier. */
type Record_ = {
  tokens?: OAuthTokens
  client?: OAuthClientInformationMixed
  verifier?: string
  updatedAt: string
}

/**
 * OAuth credentials for HTTP MCP servers, next to Pi's own auth.json and, like it, readable
 * only by the user. A record belongs to one server name at one URL: changing the URL signs
 * the server out rather than sending its tokens somewhere new.
 */
export class McpTokenStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(readonly path: string) {}

  static key(id: string, url: string): string {
    return `${id}:${createHash('sha256').update(url).digest('hex').slice(0, 16)}`
  }

  private async load(): Promise<Record<string, Record_>> {
    try {
      const stat = await lstat(this.path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return {}
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, Record_>)
        : {}
    } catch {
      return {}
    }
  }

  async get(key: string): Promise<Record_ | undefined> {
    await this.queue.catch(() => {})
    return (await this.load())[key]
  }

  /** Serialized read-modify-write with an atomic, owner-only replace. */
  update(
    key: string,
    change: (current: Record_ | undefined) => Record_ | undefined
  ): Promise<void> {
    const next = this.queue.then(async () => {
      const all = await this.load()
      const value = change(all[key])
      if (value) all[key] = { ...value, updatedAt: new Date().toISOString() }
      else delete all[key]
      await mkdir(dirname(this.path), { recursive: true })
      const temp = `${this.path}.${randomUUID()}.tmp`
      try {
        const file = await open(temp, 'wx', 0o600)
        try {
          await file.writeFile(JSON.stringify(all, null, 2))
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(temp, this.path)
      } finally {
        await unlink(temp).catch(() => {})
      }
    })
    this.queue = next.catch(() => {})
    return next
  }
}

export type OAuthOptions = NonNullable<McpServer['oauth']>

/** Thrown where a background connection would have to involve the user. */
export class McpAuthRequired extends Error {
  constructor() {
    super('MCP 服务器需要登录')
  }
}

/** The redirect a background provider claims; it never gets as far as using it. */
const BACKGROUND_REDIRECT = 'http://127.0.0.1/callback'

/**
 * The SDK drives discovery, dynamic client registration, PKCE and refresh; this provider only
 * stores what it hands over. With `login` it runs an explicit sign-in and opens the browser;
 * without it, it serves stored tokens and refreshes them, and anything that would need the
 * user (registering, a new authorization) stops with McpAuthRequired instead, so no browser
 * ever opens on its own and an in-flight login's verifier is never overwritten.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private readonly nonce = randomBytes(16).toString('base64url')
  /** Set once the server asked for a sign-in this provider could not give. */
  required = false
  constructor(
    private readonly store: McpTokenStore,
    private readonly key: string,
    private readonly options: OAuthOptions,
    private readonly login?: {
      redirect: string
      state: string
      open: (url: URL) => void | Promise<void>
    }
  ) {}

  private stop(): never {
    this.required = true
    throw new McpAuthRequired()
  }

  get redirectUrl(): string {
    return this.login?.redirect ?? BACKGROUND_REDIRECT
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Pi Desktop',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.options.clientSecret ? 'client_secret_post' : 'none',
      ...(this.options.scope ? { scope: this.options.scope } : {})
    }
  }

  state(): string {
    return this.login?.state ?? this.nonce
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.options.clientId)
      return {
        client_id: this.options.clientId,
        ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {})
      }
    const client = (await this.store.get(this.key))?.client
    if (!this.login) return client ?? this.stop()
    // A client registered for another loopback port cannot receive this login's redirect.
    const uris = (client as { redirect_uris?: string[] } | undefined)?.redirect_uris
    if (client && uris && !uris.includes(this.login.redirect)) return undefined
    return client
  }

  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    if (!this.login) this.stop()
    if (this.options.clientId) return
    await this.store.update(this.key, (current) => ({ ...current, client, updatedAt: '' }))
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.store.get(this.key))?.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.update(this.key, (current) => ({ ...current, tokens, updatedAt: '' }))
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.login) this.stop()
    await this.login.open(url)
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    if (!this.login) this.stop()
    await this.store.update(this.key, (current) => ({ ...current, verifier, updatedAt: '' }))
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.store.get(this.key))?.verifier
    if (!verifier) throw new Error('No PKCE verifier')
    return verifier
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> {
    if (scope === 'discovery') return
    await this.store.update(this.key, (current) => {
      if (!current || scope === 'all') return undefined
      const next = { ...current }
      if (scope === 'client') delete next.client
      if (scope === 'tokens') delete next.tokens
      if (scope === 'verifier') delete next.verifier
      return next
    })
  }
}

const CALLBACK_PAGE = (ok: boolean): string =>
  `<!doctype html><meta charset="utf-8"><title>Pi Desktop</title>` +
  `<body style="font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#333">` +
  `<p>${ok ? '登录完成，可以回到 Pi Desktop。' : '登录没有完成，请回到 Pi Desktop 重试。'}</p></body>`

/**
 * A one-shot loopback receiver for the authorization redirect (RFC 8252). It listens on
 * 127.0.0.1 only, accepts exactly one callback carrying the expected state, and closes.
 */
export class LoopbackCallback {
  private server?: Server
  private settle?: { resolve: (code: string) => void; reject: (error: Error) => void }
  readonly code: Promise<string>
  url = ''

  constructor(
    private readonly state: string,
    private readonly port = 0
  ) {
    this.code = new Promise<string>((resolve, reject) => {
      this.settle = { resolve, reject }
    })
    this.code.catch(() => {})
  }

  async listen(): Promise<string> {
    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        response.writeHead(404).end()
        return
      }
      const code = url.searchParams.get('code')
      const ok = Boolean(code) && url.searchParams.get('state') === this.state
      response.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
      response.end(CALLBACK_PAGE(ok))
      if (ok) this.settle?.resolve(code!)
      else
        this.settle?.reject(
          new Error(
            url.searchParams.get('error') === 'access_denied'
              ? '授权被拒绝。'
              : '授权回调无效，请重新登录。'
          )
        )
      void this.close()
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.port, '127.0.0.1', () => resolve())
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('无法监听本机回调端口')
    this.url = `http://127.0.0.1:${address.port}/callback`
    return this.url
  }

  fail(error: Error): void {
    this.settle?.reject(error)
    void this.close()
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
