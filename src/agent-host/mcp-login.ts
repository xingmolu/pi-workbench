import { randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { McpServer } from '../shared/mcp'
import { LoopbackCallback, McpOAuthProvider, McpTokenStore } from './mcp-oauth'
import { httpTransport } from './mcp-runtime'
import { t } from '../shared/i18n'

type Pending = { status: 'authorizing' } | { status: 'failed'; message: string }

const LOGIN_TIMEOUT = 5 * 60 * 1000

/**
 * Explicit browser sign-ins for HTTP MCP servers. A login answers the settings page at once
 * and then waits for the redirect, so it is never bound by the host's request timeout; the
 * page polls `state` until the login settles.
 */
export class McpLogins {
  private readonly pending = new Map<string, Pending>()
  private readonly running = new Map<string, LoopbackCallback>()
  constructor(
    private readonly store: McpTokenStore,
    private readonly openExternal: (url: string) => void,
    private readonly timeout = LOGIN_TIMEOUT
  ) {}

  state(id: string): Pending | undefined {
    return this.pending.get(id)
  }

  async authorized(id: string, url: string): Promise<boolean> {
    return Boolean((await this.store.get(McpTokenStore.key(id, url)))?.tokens)
  }

  /** Starts a sign-in; `settled` runs once it succeeded so the caller can reconnect. */
  start(id: string, config: McpServer, settled: () => Promise<unknown>): void {
    if (!config.url) throw new Error(t('只有 HTTP 服务器支持登录。'))
    this.cancel(id)
    this.pending.set(id, { status: 'authorizing' })
    const key = McpTokenStore.key(id, config.url)
    const run = async (callback: LoopbackCallback): Promise<void> => {
      const redirect = await callback.listen()
      const provider = new McpOAuthProvider(this.store, key, config.oauth ?? {}, {
        redirect,
        state,
        open: (url) => {
          if (url.protocol !== 'https:' && url.protocol !== 'http:')
            throw new Error(t('授权地址无效。'))
          this.openExternal(url.href)
        }
      })
      const transport = httpTransport(config, provider)
      const client = new Client({ name: 'pi-desktop', version: '0.1.0' }, { capabilities: {} })
      try {
        try {
          await client.connect(transport, { timeout: config.timeout ?? 15000 })
          return // Already signed in, or the server did not ask for it.
        } catch (error) {
          if (!(error instanceof UnauthorizedError)) throw error
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const code = await Promise.race([
          callback.code,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(t('登录超时，请重试。'))), this.timeout)
          })
        ]).finally(() => clearTimeout(timer))
        await transport.finishAuth(code)
        await this.store.update(key, (current) => current && { ...current, verifier: undefined })
      } finally {
        await client.close().catch(() => {})
        await transport.close().catch(() => {})
      }
    }
    const state = randomBytes(24).toString('base64url')
    const callback = new LoopbackCallback(state, config.oauth?.redirectPort)
    this.running.set(id, callback)
    void run(callback)
      .then(async () => {
        if (this.running.get(id) !== callback) return
        this.pending.delete(id)
        await settled().catch(() => {})
      })
      .catch((error: unknown) => {
        if (this.running.get(id) !== callback) return
        this.pending.set(id, { status: 'failed', message: loginMessage(error) })
      })
      .finally(() => {
        if (this.running.get(id) === callback) this.running.delete(id)
        void callback.close()
      })
  }

  cancel(id: string): void {
    const callback = this.running.get(id)
    this.running.delete(id)
    this.pending.delete(id)
    callback?.fail(new Error(t('登录已取消。')))
  }

  async logout(id: string, url: string): Promise<void> {
    this.cancel(id)
    await this.store.update(McpTokenStore.key(id, url), () => undefined)
  }

  close(): void {
    for (const id of [...this.running.keys()]) this.cancel(id)
  }
}

/** Only messages written here reach the page; upstream errors may carry URLs or tokens. */
function loginMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (
    [
      t('授权被拒绝。'),
      t('授权回调无效，请重新登录。'),
      t('登录超时，请重试。'),
      t('授权地址无效。')
    ].includes(message)
  )
    return message
  if ((error as NodeJS.ErrnoException)?.code === 'EADDRINUSE')
    return t('回调端口被占用，请更换端口后重试。')
  return t('登录失败：服务器不支持 OAuth 或授权未完成，请检查配置后重试。')
}
