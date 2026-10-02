import { createHash } from 'node:crypto'
import {
  mcpIdSchema,
  mcpServerSchema,
  type McpCommand,
  type McpServer,
  type McpSnapshot,
  type McpSummary
} from '../shared/mcp'
import type { AppServerClient } from './app-server'
import { t } from '../shared/i18n'

/** One `[mcp_servers.<id>]` table of Codex's config.toml. */
type CodexMcpEntry = {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  http_headers?: Record<string, string>
  enabled?: boolean
  startup_timeout_sec?: number
}

type CodexMcpStatus = {
  name: string
  authStatus: 'unknown' | 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth'
  runtimeStatus?:
    | 'notStarted'
    | 'starting'
    | 'connected'
    | 'authenticationRequired'
    | 'failed'
    | 'cancelled'
    | 'disabled'
    | null
  tools: Record<string, unknown>
  toolsError?: string | null
}

/**
 * MCP servers live in Codex's own config.toml (in the desktop's Codex home), read and written
 * through app-server so Codex validates every change and reloads its servers itself.
 */
export class CodexMcp {
  private readonly loginErrors = new Map<string, string>()

  constructor(
    private readonly server: () => AppServerClient,
    private readonly threadId: () => string | undefined,
    private readonly openExternal: (url: string) => void
  ) {}

  /** `mcpServer/oauthLogin/completed` from app-server. */
  loginCompleted(params: { name: string; success: boolean; error?: string | null }): void {
    if (params.success) this.loginErrors.delete(params.name)
    else this.loginErrors.set(params.name, params.error ?? t('登录失败'))
  }

  async handle(command: McpCommand): Promise<McpSnapshot> {
    switch (command.type) {
      case 'mcp:list':
      case 'mcp:shutdown':
        return this.snapshot()
      case 'mcp:reload':
        await this.server().request('config/mcpServer/reload', {})
        return this.snapshot()
      case 'mcp:save': {
        const { servers, revision } = await this.read()
        if (command.revision !== revision) throw new Error(t('MCP 配置已变化，请刷新后再保存'))
        if (command.create && servers[command.id]) throw new Error(t('已有同名的 MCP 服务'))
        if (!command.create && !servers[command.id]) throw new Error(t('这个 MCP 服务已不存在'))
        await this.write(
          command.id,
          toCodex(mcpServerSchema.parse(command.server), command.enabled)
        )
        return { ...(await this.snapshot()), saved: true, applied: true }
      }
      case 'mcp:toggle': {
        const { servers, revision } = await this.read()
        if (command.revision !== revision) throw new Error(t('MCP 配置已变化，请刷新后再保存'))
        const entry = servers[command.id]
        if (!entry) throw new Error(t('这个 MCP 服务已不存在'))
        await this.write(`${command.id}.enabled`, command.enabled)
        return this.snapshot()
      }
      case 'mcp:login': {
        this.loginErrors.delete(command.id)
        const threadId = this.threadId()
        const login = await this.server().request<{ authorizationUrl: string }>(
          'mcpServer/oauth/login',
          { name: command.id, ...(threadId ? { threadId } : {}) }
        )
        this.openExternal(login.authorizationUrl)
        return this.snapshot()
      }
      case 'mcp:logout':
        throw new Error(t('Codex 暂不支持在这里退出 MCP 登录'))
    }
  }

  private async read(): Promise<{ servers: Record<string, CodexMcpEntry>; revision: string }> {
    const result = await this.server().request<{ config: { mcp_servers?: unknown } }>(
      'config/read',
      {}
    )
    const raw = result.config.mcp_servers
    const servers = raw && typeof raw === 'object' ? (raw as Record<string, CodexMcpEntry>) : {}
    return {
      servers,
      revision: createHash('sha256').update(JSON.stringify(servers)).digest('hex').slice(0, 16)
    }
  }

  private async write(key: string, value: CodexMcpEntry | boolean): Promise<void> {
    await this.server().request('config/value/write', {
      keyPath: `mcp_servers.${key}`,
      value,
      mergeStrategy: 'replace'
    })
    await this.server().request('config/mcpServer/reload', {})
  }

  private async snapshot(): Promise<McpSnapshot> {
    const { servers, revision } = await this.read()
    const threadId = this.threadId()
    const statuses = await this.server()
      .request<{ data: CodexMcpStatus[] }>('mcpServerStatus/list', {
        detail: 'toolsAndAuthOnly',
        ...(threadId ? { threadId } : {})
      })
      .then((result) => new Map(result.data.map((status) => [status.name, status])))
      .catch(() => new Map<string, CodexMcpStatus>())
    return {
      revision,
      writable: true,
      servers: Object.entries(servers)
        .filter(([id]) => mcpIdSchema.safeParse(id).success)
        .slice(0, 16)
        .map(([id, entry]) => this.summary(id, entry, statuses.get(id)))
    }
  }

  private summary(id: string, entry: CodexMcpEntry, status?: CodexMcpStatus): McpSummary {
    const enabled = entry.enabled !== false
    const transport = entry.command ? 'stdio' : entry.url ? 'http' : 'unsupported'
    const loginError = this.loginErrors.get(id)
    const runtime = status?.runtimeStatus
    const state: McpSummary['status'] = !enabled
      ? 'disabled'
      : transport === 'unsupported'
        ? 'unsupported'
        : runtime === 'authenticationRequired' || status?.authStatus === 'notLoggedIn'
          ? 'needs-auth'
          : runtime === 'connected'
            ? 'connected'
            : runtime === 'starting'
              ? 'connecting'
              : runtime === 'failed' || status?.toolsError || loginError
                ? 'error'
                : status && Object.keys(status.tools).length
                  ? 'connected'
                  : 'disconnected'
    const message = loginError ?? status?.toolsError ?? undefined
    return {
      id,
      transport,
      ...(entry.command ? { command: entry.command.slice(0, 2048) } : {}),
      ...(entry.args ? { args: entry.args.slice(0, 64).map((arg) => arg.slice(0, 8192)) } : {}),
      ...(entry.url ? { url: entry.url.slice(0, 2048) } : {}),
      ...(entry.startup_timeout_sec ? { timeout: entry.startup_timeout_sec * 1000 } : {}),
      envKeys: Object.keys(entry.env ?? {}).slice(0, 32),
      headerKeys: Object.keys(entry.http_headers ?? {}).slice(0, 32),
      ...(transport === 'http'
        ? { oauth: { hasSecret: false, authorized: status?.authStatus === 'oAuth' } }
        : {}),
      enabled,
      editable: true,
      status: state,
      toolCount: Math.min(Object.keys(status?.tools ?? {}).length, 128),
      ...(message ? { message: message.slice(0, 240) } : {})
    }
  }
}

function toCodex(server: McpServer, enabled: boolean): CodexMcpEntry {
  if (server.oauth) throw new Error(t('Codex 会自动发现 OAuth 设置，暂不支持自定义 OAuth 客户端'))
  return {
    ...(server.command ? { command: server.command } : {}),
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.headers && Object.keys(server.headers).length
      ? { http_headers: server.headers }
      : {}),
    ...(server.timeout ? { startup_timeout_sec: Math.ceil(server.timeout / 1000) } : {}),
    enabled
  }
}
