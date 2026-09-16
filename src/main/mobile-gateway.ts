import { hostname as osHostname } from 'node:os'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { MOBILE_GATEWAY_LOOPBACK, MOBILE_GATEWAY_PORT } from '../shared/mobile-gateway'
import { buildMobileHomeGroups } from '../shared/mobile-list'
import { encodeQrMatrix, renderQrSvg } from '../shared/qr'
import {
  assertGatewayBindAddress,
  pairingUrl,
  primaryLanIpv4
} from './mobile-gateway-net'
import type { MobilePairingStore } from './mobile-pairing'
import type { MobileSessionBridge } from './mobile-session-bridge'
import { mobileManifest, mobilePageHtml } from './mobile-web-page'

const BODY_LIMIT = 64 * 1024
const COOKIE = 'pi_device'

export type MobileGatewayOptions = {
  pairing: MobilePairingStore
  sessions: MobileSessionBridge
  port?: number
  lanAddress?: () => string | null
  hostName?: () => string
  listen?: (server: Server, port: number, host: string) => Promise<void>
}

type SseClient = { workerId: string; response: ServerResponse }

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        request.destroy()
        reject(new Error('请求过大'))
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
  private unsubscribe: (() => void) | null = null
  constructor(private readonly options: MobileGatewayOptions) {}

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
    const url =
      withPairToken(remoteUrl, token) ?? this.lanUrl(token) ?? this.loopbackUrl(token)
    if (!url) throw new Error('网关未启动')
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
      for (const client of this.sse) {
        if (client.workerId !== event.workerId) continue
        this.writeSse(client.response, 'snapshot', event.snapshot)
        if (event.runFinished) this.writeSse(client.response, 'run-finished', { workerId: event.workerId })
      }
    })
  }

  async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const client of this.sse) {
      client.response.end()
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

  private writeSse(response: ServerResponse, event: string, data: unknown): void {
    if (response.writableEnded) return
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const host = hostnameOf(request.headers.host)
      if (!this.allowedHosts().has(host) && !host.endsWith('.ts.net')) {
        json(response, 421, { error: '拒绝未知 Host' })
        return
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy':
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'",
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff'
        })
        response.end(mobilePageHtml())
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
        const grant = this.options.pairing.pair(String(body.token ?? ''), String(body.deviceName ?? '手机'))
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'set-cookie': `${COOKIE}=${encodeURIComponent(grant.deviceToken)}; Path=/; SameSite=Lax`
        })
        response.end(JSON.stringify({ deviceId: grant.deviceId, deviceToken: grant.deviceToken, device: grant.device }))
        return
      }
      const device = this.requireDevice(request, url)
      if (!device) {
        json(response, 401, { error: '尚未配对' })
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
      if (request.method === 'POST' && url.pathname === '/api/sessions/open') {
        const body = JSON.parse((await readBody(request)) || '{}') as {
          cwd?: string
          sessionPath?: string
        }
        if (!body.cwd) {
          json(response, 400, { error: '缺少项目路径' })
          return
        }
        json(response, 200, await this.options.sessions.open(body.cwd, body.sessionPath))
        return
      }
      const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname)
      if (sessionMatch) {
        const workerId = decodeURIComponent(sessionMatch[1]!)
        const action = sessionMatch[2]
        if (request.method === 'GET' && !action) {
          const snapshot = this.options.sessions.snapshot(workerId)
          if (!snapshot) {
            json(response, 404, { error: '会话不在运行' })
            return
          }
          json(response, 200, snapshot)
          return
        }
        if (request.method === 'GET' && action === 'events') {
          response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive'
          })
          const client = { workerId, response }
          this.sse.add(client)
          const current = this.options.sessions.snapshot(workerId)
          if (current) this.writeSse(response, 'snapshot', current)
          request.on('close', () => this.sse.delete(client))
          return
        }
        const body = JSON.parse((await readBody(request)) || '{}') as Record<string, unknown>
        if (request.method === 'POST' && action === 'send') {
          await this.options.sessions.send(
            workerId,
            String(body.text ?? ''),
            String(body.sessionId ?? ''),
            Number(body.generation ?? 0)
          )
          json(response, 200, { ok: true })
          return
        }
        if (request.method === 'POST' && action === 'abort') {
          await this.options.sessions.abort(workerId)
          json(response, 200, { ok: true })
          return
        }
        if (request.method === 'POST' && action === 'approval') {
          await this.options.sessions.respond(workerId, String(body.approvalId ?? ''), body.allow === true)
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
      json(response, 404, { error: '未知接口' })
    } catch (error) {
      const message = error instanceof Error ? error.message : '网关错误'
      const status = /配对码|尚未配对|已达到/.test(message) ? 401 : 400
      if (!response.headersSent) json(response, status, { error: message })
    }
  }
}
