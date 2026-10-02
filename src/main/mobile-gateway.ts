import { hostname as osHostname } from 'node:os'
import { z } from 'zod'
import { MAX_PROMPT_IMAGES, promptImageSchema, thinkingLevelSchema } from '../shared/schemas'
import type { RemoteViewAccess, RemoteViewSummary } from '../shared/remote-views'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { MOBILE_GATEWAY_LOOPBACK, MOBILE_GATEWAY_PORT } from '../shared/mobile-gateway'
import { buildMobileHomeGroups } from '../shared/mobile-list'
import { encodeQrMatrix, renderQrSvg } from '../shared/qr'
import { assertGatewayBindAddress, pairingUrl, primaryLanIpv4 } from './mobile-gateway-net'
import type { MobilePairingStore } from './mobile-pairing'
import type { MobileSessionBridge } from './mobile-session-bridge'
import {
  MOBILE_PLUGIN_FRAME_CSP,
  MOBILE_PLUGIN_FRAME_PREFIX,
  mobilePluginCallSchema,
  mobilePluginOpenSchema,
  type MobilePluginViews
} from './mobile-plugin-views'
import { MobileSnapshotStream, type MobileSnapshotStreamOptions } from './mobile-snapshot-stream'
import {
  MOBILE_PAGE_CSP,
  MOBILE_WEB_ROOT,
  mobileAsset,
  mobileManifest,
  mobilePageHtml,
  mobileRootFile,
  mobileUnavailableHtml
} from './mobile-web-page'
import { t } from '../shared/i18n'

const BODY_LIMIT = 64 * 1024
/** A prompt may carry up to four phone photos; the page downsizes them before upload. */
const SEND_BODY_LIMIT = 24 * 1024 * 1024

const identitySchema = z.object({
  sessionId: z.string().min(1).max(256),
  generation: z.number().int().nonnegative()
})
const sendSchema = identitySchema.extend({
  text: z.string().max(1024 * 1024),
  images: z.array(promptImageSchema).min(1).max(MAX_PROMPT_IMAGES).optional()
})
const modelSchema = identitySchema.extend({
  providerId: z.string().min(1).max(256),
  modelId: z.string().min(1).max(256)
})
const permissionSchema = z.object({ mode: z.enum(['ask', 'auto', 'open']) })
const thinkingSchema = identitySchema.extend({ level: thinkingLevelSchema })
const checkpointSchema = identitySchema.extend({
  entryId: z.string().min(1).max(256),
  restore: z.boolean().optional(),
  force: z.boolean().optional()
})
const newSessionSchema = z.object({
  cwd: z.string().min(1).max(4096),
  providerId: z.string().min(1).max(256).optional(),
  modelId: z.string().min(1).max(256).optional()
})
/** Invalid input answers 400 with a fixed message instead of echoing the parser. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error(t('请求参数无效'))
  return result.data
}
const COOKIE = 'pi_device'

export type MobileGatewayOptions = {
  pairing: MobilePairingStore
  sessions: MobileSessionBridge
  snapshotStream?: MobileSnapshotStreamOptions
  maxConnectionsPerDevice?: number
  maxConnections?: number
  port?: number
  lanAddress?: () => string | null
  hostName?: () => string
  listen?: (server: Server, port: number, host: string) => Promise<void>
  /** Directory holding the built mobile.html and assets/ (defaults to out/renderer). */
  webRoot?: string
  /** The desktop's workbench views (browser, terminals) for remote viewing. */
  views?: MobileViewsBridge
}

export type MobileViewsBridge = {
  access(): RemoteViewAccess
  list(): RemoteViewSummary[]
  /** Null when the view does not exist. */
  subscribe(id: string, send: (event: string, data: unknown) => void): (() => void) | null
  /** Validates `input` for the view's kind before acting. */
  input(id: string, input: unknown): Promise<void>
  /** Plugin pages that opted into the phone. */
  plugins?: MobilePluginViews
}

/** Frames are dropped, never queued, while a phone's connection is behind. */
const VIEW_BACKLOG_BYTES = 4 * 1024 * 1024
const MAX_VIEW_STREAMS_PER_DEVICE = 4

type SseClient = {
  deviceId: string
  workerId: string
  response: ServerResponse
  stream: MobileSnapshotStream
}

function readBody(request: IncomingMessage, limit = BODY_LIMIT): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        request.destroy()
        reject(new Error(t('请求过大')))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  response.end(payload)
}

function hostnameOf(hostHeader: string | undefined): string {
  return (hostHeader ?? '').split(':')[0]!.toLowerCase()
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

function listenOn(server: Server, port: number, host: string): Promise<void> {
  assertGatewayBindAddress(host)
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function withPairToken(origin: string | null | undefined, token: string): string | null {
  if (!origin) return null
  try {
    const url = new URL(origin)
    if (!url.protocol.startsWith('http')) return null
    url.searchParams.set('pair', token)
    return url.toString()
  } catch {
    return null
  }
}

export class MobileGatewayServer {
  private loopback: Server | null = null
  private lan: Server | null = null
  private running = false
  private port: number | null = null
  private lanAddress: string | null = null
  private readonly sse = new Set<SseClient>()
  private readonly viewStreams = new Map<ServerResponse, { deviceId: string; stop: () => void }>()
  private unsubscribe: (() => void) | null = null
  constructor(private readonly options: MobileGatewayOptions) {}

  getDiagnostics(): { connections: number; blocked: number; pendingSnapshots: number } {
    let blocked = 0
    let pendingSnapshots = 0
    for (const client of this.sse) {
      const state = client.stream.getDiagnostics()
      if (state.blocked) blocked++
      if (state.pending) pendingSnapshots++
    }
    return { connections: this.sse.size, blocked, pendingSnapshots }
  }

  get isRunning(): boolean {
    return this.running
  }

  get listenPort(): number | null {
    return this.port
  }

  getLanAddress(): string | null {
    return this.lanAddress
  }

  loopbackUrl(token?: string): string | null {
    return this.port ? pairingUrl(MOBILE_GATEWAY_LOOPBACK, this.port, token) : null
  }

  lanUrl(token?: string): string | null {
    return this.port && this.lanAddress ? pairingUrl(this.lanAddress, this.port, token) : null
  }

  pairingPayload(
    token: string,
    expiresAt: number,
    remoteUrl?: string | null
  ): {
    token: string
    expiresAt: number
    url: string
    qrSvg: string
  } {
    const url = withPairToken(remoteUrl, token) ?? this.lanUrl(token) ?? this.loopbackUrl(token)
    if (!url) throw new Error(t('网关未启动'))
    return {
      token,
      expiresAt,
      url,
      qrSvg: renderQrSvg(encodeQrMatrix(url))
    }
  }

  async start(): Promise<void> {
    if (this.running) return
    const port = this.options.port ?? MOBILE_GATEWAY_PORT
    const handler = (request: IncomingMessage, response: ServerResponse): void => {
      void this.handle(request, response)
    }
    const bind = this.options.listen ?? listenOn
    const loopback = createServer(handler)
    await bind(loopback, port, MOBILE_GATEWAY_LOOPBACK)
    this.loopback = loopback
    this.port = port
    this.running = true
    const lanHost = this.options.lanAddress ? this.options.lanAddress() : primaryLanIpv4()
    if (lanHost) {
      try {
        const lanServer = createServer(handler)
        await bind(lanServer, port, lanHost)
        this.lan = lanServer
        this.lanAddress = lanHost
      } catch {
        this.lanAddress = null
      }
    }
    this.unsubscribe = this.options.sessions.subscribe((event) => {
      // Serialize at most once per delivered revision, shared by all devices.
      let serialized: string | undefined
      const snapshot = (): string => (serialized ??= JSON.stringify(event.snapshot))
      for (const client of this.sse) {
        if (client.workerId !== event.workerId) continue
        client.stream.publish(
          snapshot,
          event.runFinished || !event.snapshot.busy || event.snapshot.approvals.length > 0,
          event.runFinished
        )
      }
    })
  }

  /** Ends every remote view stream, e.g. when the desktop turns remote views off. */
  closeViews(): void {
    for (const [response, stream] of this.viewStreams) {
      stream.stop()
      response.destroy()
    }
    this.viewStreams.clear()
  }

  async stop(): Promise<void> {
    this.closeViews()
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const client of this.sse) {
      client.stream.dispose()
      client.response.destroy()
    }
    this.sse.clear()
    await Promise.all([this.close(this.loopback), this.close(this.lan)])
    this.loopback = null
    this.lan = null
    this.running = false
    this.port = null
    this.lanAddress = null
    this.options.pairing.clearOffer()
  }

  private close(server: Server | null): Promise<void> {
    if (!server) return Promise.resolve()
    return new Promise((resolve) => server.close(() => resolve()))
  }

  private allowedHosts(): Set<string> {
    const hosts = new Set(['127.0.0.1', 'localhost'])
    if (this.lanAddress) hosts.add(this.lanAddress.toLowerCase())
    return hosts
  }

  private deviceToken(request: IncomingMessage, url: URL): string | null {
    const header = request.headers.authorization
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim()
    const cookie = cookieValue(request.headers.cookie, COOKIE)
    if (cookie) return cookie
    const query = url.searchParams.get('token')
    return query && query.length > 0 ? query : null
  }

  private requireDevice(request: IncomingMessage, url: URL) {
    const token = this.deviceToken(request, url)
    if (!token) return null
    return this.options.pairing.authenticate(token)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const host = hostnameOf(request.headers.host)
      if (!this.allowedHosts().has(host) && !host.endsWith('.ts.net')) {
        json(response, 421, { error: t('拒绝未知 Host') })
        return
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = await mobilePageHtml(this.options.webRoot ?? MOBILE_WEB_ROOT)
        response.writeHead(html ? 200 : 503, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': MOBILE_PAGE_CSP,
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff'
        })
        response.end(html ?? mobileUnavailableHtml())
        return
      }
      if (request.method === 'GET' && (url.pathname === '/sw.js' || url.pathname === '/icon.png')) {
        const file = await mobileRootFile(url.pathname, this.options.webRoot ?? MOBILE_WEB_ROOT)
        if (!file) {
          json(response, 404, { error: t('未知资源') })
          return
        }
        response.writeHead(200, {
          'content-type': file.type,
          // The worker must be re-checked on every load so updates reach installed apps.
          'cache-control': url.pathname === '/sw.js' ? 'no-cache' : 'public, max-age=86400',
          'x-content-type-options': 'nosniff'
        })
        response.end(file.body)
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/assets/')) {
        const asset = await mobileAsset(url.pathname, this.options.webRoot ?? MOBILE_WEB_ROOT)
        if (!asset) {
          json(response, 404, { error: t('未知资源') })
          return
        }
        // Build assets carry a content hash in their names.
        response.writeHead(200, {
          'content-type': asset.type,
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff'
        })
        response.end(asset.body)
        return
      }
      if (request.method === 'GET' && url.pathname === '/manifest.webmanifest') {
        response.writeHead(200, {
          'content-type': 'application/manifest+json; charset=utf-8',
          'cache-control': 'no-store'
        })
        response.end(mobileManifest())
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/pair') {
        const body = JSON.parse((await readBody(request)) || '{}') as {
          token?: string
          deviceName?: string
        }
        const grant = this.options.pairing.pair(
          String(body.token ?? ''),
          String(body.deviceName ?? t('手机'))
        )
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'set-cookie': `${COOKIE}=${encodeURIComponent(grant.deviceToken)}; Path=/; SameSite=Lax`
        })
        response.end(
          JSON.stringify({
            deviceId: grant.deviceId,
            deviceToken: grant.deviceToken,
            device: grant.device
          })
        )
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith(MOBILE_PLUGIN_FRAME_PREFIX)) {
        // Frames load with an opaque origin and no device cookie; the URL token is the grant.
        const plugins = this.options.views?.plugins
        const file =
          plugins && this.options.views?.access() !== 'off'
            ? await plugins.file(url.pathname)
            : null
        response.writeHead(file ? file.status : 404, {
          'content-type': file ? file.type : 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': MOBILE_PLUGIN_FRAME_CSP,
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer'
        })
        response.end(file ? file.body : t('未找到'))
        return
      }
      const device = this.requireDevice(request, url)
      if (!device) {
        json(response, 401, { error: t('尚未配对') })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/me') {
        json(response, 200, { device })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        const live = this.options.sessions.listLive()
        const catalog = await this.options.sessions.listCatalog()
        json(response, 200, {
          host: (this.options.hostName ?? osHostname)(),
          live,
          catalog,
          groups: buildMobileHomeGroups(live, catalog)
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/sessions/new') {
        const body = parse(newSessionSchema, JSON.parse((await readBody(request)) || '{}'))
        const model =
          body.providerId && body.modelId
            ? { providerId: body.providerId, modelId: body.modelId }
            : undefined
        json(response, 200, await this.options.sessions.open(body.cwd, undefined, model))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/sessions/open') {
        const body = JSON.parse((await readBody(request)) || '{}') as {
          cwd?: string
          sessionPath?: string
        }
        if (!body.cwd) {
          json(response, 400, { error: t('缺少项目路径') })
          return
        }
        json(response, 200, await this.options.sessions.open(body.cwd, body.sessionPath))
        return
      }
      if (url.pathname === '/api/views' || url.pathname.startsWith('/api/views/')) {
        await this.handleViews(request, response, url, device.deviceId)
        return
      }
      if (url.pathname === '/api/plugins' || url.pathname.startsWith('/api/plugins/')) {
        await this.handlePlugins(request, response, url, device.deviceId)
        return
      }
      const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname)
      if (sessionMatch) {
        const workerId = decodeURIComponent(sessionMatch[1]!)
        const action = sessionMatch[2]
        if (request.method === 'GET' && !action) {
          const snapshot = this.options.sessions.snapshot(workerId)
          if (!snapshot) {
            json(response, 404, { error: t('会话不在运行') })
            return
          }
          json(response, 200, snapshot)
          return
        }
        if (request.method === 'GET' && action === 'events') {
          const current = this.options.sessions.snapshot(workerId)
          if (!current) {
            json(response, 404, { error: t('会话不在运行') })
            return
          }
          const deviceConnections = [...this.sse].filter(
            (client) => client.deviceId === device.deviceId
          ).length
          if (
            this.sse.size >= (this.options.maxConnections ?? 32) ||
            deviceConnections >= (this.options.maxConnectionsPerDevice ?? 8)
          ) {
            json(response, 429, { error: t('实时连接已达到上限') })
            return
          }
          response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive'
          })
          const client = {
            deviceId: device.deviceId,
            workerId,
            response,
            stream: new MobileSnapshotStream(response, workerId, this.options.snapshotStream)
          }
          this.sse.add(client)
          const cleanup = (): void => {
            client.stream.dispose()
            this.sse.delete(client)
          }
          response.on('close', cleanup)
          response.on('error', cleanup)
          client.stream.publish(() => JSON.stringify(current), true)
          return
        }
        const body = JSON.parse(
          (await readBody(request, action === 'send' ? SEND_BODY_LIMIT : BODY_LIMIT)) || '{}'
        ) as Record<string, unknown>
        if (request.method === 'POST' && action === 'send') {
          const input = parse(sendSchema, body)
          if (!input.text.trim() && !input.images) throw new Error(t('请输入任务内容'))
          await this.options.sessions.send(
            workerId,
            input.text,
            input.sessionId,
            input.generation,
            input.images
          )
          json(response, 200, { ok: true })
          return
        }
        if (request.method === 'POST' && action === 'model') {
          const input = parse(modelSchema, body)
          await this.options.sessions.setModel(
            workerId,
            { sessionId: input.sessionId, generation: input.generation },
            input.providerId,
            input.modelId
          )
          json(response, 200, { ok: true })
          return
        }
        if (request.method === 'POST' && action === 'permission') {
          await this.options.sessions.setPermission(workerId, parse(permissionSchema, body).mode)
          json(response, 200, { ok: true })
          return
        }
        if (request.method === 'POST' && action === 'thinking') {
          const input = parse(thinkingSchema, body)
          await this.options.sessions.setThinking(
            workerId,
            { sessionId: input.sessionId, generation: input.generation },
            input.level
          )
          json(response, 200, { ok: true })
          return
        }
        if (request.method === 'POST' && action === 'skills') {
          const skills = await this.options.sessions.skills(workerId, parse(identitySchema, body))
          json(response, 200, { skills })
          return
        }
        if (request.method === 'POST' && action === 'checkpoint') {
          const input = parse(checkpointSchema, body)
          const identity = { sessionId: input.sessionId, generation: input.generation }
          json(
            response,
            200,
            input.restore
              ? {
                  outcome: await this.options.sessions.checkpointRestore(
                    workerId,
                    identity,
                    input.entryId,
                    input.force === true
                  )
                }
              : {
                  plan: await this.options.sessions.checkpointPlan(
                    workerId,
                    identity,
                    input.entryId
                  )
                }
          )
          return
        }
        if (request.method === 'POST' && action === 'abort') {
          await this.options.sessions.abort(workerId)
          json(response, 200, { ok: true })
          return
        }
        if (request.method === 'POST' && action === 'approval') {
          await this.options.sessions.respond(
            workerId,
            String(body.approvalId ?? ''),
            body.allow === true,
            body.scope === 'turn' ? 'turn' : 'once'
          )
          json(response, 200, { ok: true })
          return
        }
      }
      const queueMatch = /^\/api\/sessions\/([^/]+)\/queue\/clear$/.exec(url.pathname)
      if (request.method === 'POST' && queueMatch) {
        await this.options.sessions.clearQueue(decodeURIComponent(queueMatch[1]!))
        json(response, 200, { ok: true })
        return
      }
      json(response, 404, { error: t('未知接口') })
    } catch (error) {
      const message = error instanceof Error ? error.message : t('网关错误')
      const status = /配对码|尚未配对|已达到/.test(message) ? 401 : 400
      if (!response.headersSent) json(response, status, { error: message })
    }
  }

  private async handlePlugins(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    deviceId: string
  ): Promise<void> {
    const plugins = this.options.views?.plugins
    const access = this.options.views?.access() ?? 'off'
    if (request.method === 'GET' && url.pathname === '/api/plugins') {
      json(response, 200, { access, views: access === 'off' || !plugins ? [] : plugins.list() })
      return
    }
    if (!plugins) {
      json(response, 404, { error: t('未知接口') })
      return
    }
    if (access === 'off') {
      json(response, 403, { error: t('电脑未允许远程查看工作台：请在「设置 › 手机」中开启。') })
      return
    }
    try {
      if (request.method === 'POST' && url.pathname === '/api/plugins/open') {
        const body = parse(mobilePluginOpenSchema, JSON.parse((await readBody(request)) || '{}'))
        json(response, 200, plugins.open(deviceId, body.viewId))
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/plugins/context') {
        json(response, 200, { context: plugins.context(url.searchParams.get('viewId') ?? '') })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/plugins/call') {
        const body = parse(mobilePluginCallSchema, JSON.parse((await readBody(request)) || '{}'))
        json(response, 200, await plugins.call(deviceId, access, body))
        return
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t('插件页面不可用')
      json(response, error instanceof SyntaxError || message === t('请求参数无效') ? 400 : 404, {
        error: error instanceof SyntaxError ? t('请求参数无效') : message
      })
      return
    }
    json(response, 404, { error: t('未知接口') })
  }

  private async handleViews(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    deviceId: string
  ): Promise<void> {
    const views = this.options.views
    const access = views?.access() ?? 'off'
    if (request.method === 'GET' && url.pathname === '/api/views') {
      json(response, 200, { access, views: access === 'off' || !views ? [] : views.list() })
      return
    }
    const match = /^\/api\/views\/([^/]+)\/(events|input)$/.exec(url.pathname)
    if (!match || !views) {
      json(response, 404, { error: t('未知接口') })
      return
    }
    const id = decodeURIComponent(match[1]!)
    if (access === 'off' || (match[2] === 'input' && access !== 'control')) {
      json(response, 403, {
        error:
          access === 'off'
            ? t('电脑未允许远程查看工作台：请在「设置 › 手机」中开启。')
            : t('电脑只允许查看，不允许远程操作。')
      })
      return
    }
    if (match[2] === 'input' && request.method === 'POST') {
      await views.input(id, JSON.parse((await readBody(request)) || '{}'))
      json(response, 200, { ok: true })
      return
    }
    if (match[2] !== 'events' || request.method !== 'GET') {
      json(response, 404, { error: t('未知接口') })
      return
    }
    const mine = [...this.viewStreams.values()].filter((item) => item.deviceId === deviceId)
    if (mine.length >= MAX_VIEW_STREAMS_PER_DEVICE) {
      json(response, 429, { error: t('实时连接已达到上限') })
      return
    }
    let open = true
    const send = (event: string, data: unknown): void => {
      if (!open) return
      // A slow phone skips frames instead of piling them up in memory.
      if (event === 'frame' && response.writableLength > VIEW_BACKLOG_BYTES) return
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    const stop = views.subscribe(id, send)
    if (!stop) {
      response.end(`event: gone\ndata: {}\n\n`)
      return
    }
    const heartbeat = setInterval(() => open && response.write(': keep-alive\n\n'), 20000)
    this.viewStreams.set(response, { deviceId, stop })
    const cleanup = (): void => {
      if (!open) return
      open = false
      clearInterval(heartbeat)
      stop()
      this.viewStreams.delete(response)
    }
    response.on('close', cleanup)
    response.on('error', cleanup)
  }
}
