import { afterEach, describe, expect, it } from 'vitest'
import { request as httpRequest } from 'node:http'
import { AGENT_ENGINE, type AgentSnapshot } from '../shared/contracts'
import type { MobileCatalogProject, MobileConversationSnapshot } from '../shared/mobile-gateway'
import { MobileGatewayServer } from './mobile-gateway'
import { assertGatewayBindAddress } from './mobile-gateway-net'
import { MobilePairingStore } from './mobile-pairing'
import type { MobileSessionBridge } from './mobile-session-bridge'
import type { PairedDeviceRecord } from '../shared/mobile-gateway'

function snapshot(workerId: string): MobileConversationSnapshot {
  const base: AgentSnapshot = {
    sessionId: 'sess-1',
    generation: 2,
    revision: 4,
    ready: true,
    engine: AGENT_ENGINE,
    agentDir: '/agent',
    project: { path: '/project', name: 'project' },
    sessions: [],
    activeSessionPath: null,
    nodes: [{ id: 'u1', type: 'user', text: 'hello' }],
    accounts: [],
    models: [],
    activeProvider: 'fixture',
    activeModel: 'offline',
    modelAvailability: 'available',
    composeBlockReason: null,
    busy: false,
    status: 'idle',
    approvals: [],
    followUp: [],
    queuedCount: 0,
    permissionMode: 'ask',
    metrics: { turns: 0, steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    login: { phase: 'idle' },
    loginPrompt: null
  }
  return {
    workerId,
    cwd: '/project',
    title: 'hello',
    sessionId: base.sessionId,
    generation: base.generation,
    revision: base.revision,
    status: base.status,
    busy: false,
    approvals: [],
    followUp: [],
    queuedCount: 0,
    composeBlockReason: null,
    nodes: base.nodes
  }
}

function fakeSessions(log: string[]): MobileSessionBridge {
  const current = snapshot('worker-1')
  const catalog: MobileCatalogProject[] = [
    { path: '/project', name: 'project', sessions: [{ path: '/s.jsonl', title: '旧会话', modified: 'today', status: 'idle' }] }
  ]
  return {
    listLive: () => [
      {
        workerId: 'worker-1',
        cwd: '/project',
        sessionPath: '/s.jsonl',
        sessionId: 'sess-1',
        generation: 2,
        status: 'idle',
        selected: true,
        title: 'hello'
      }
    ],
    listCatalog: async () => catalog,
    snapshot: (workerId) => (workerId === 'worker-1' ? current : null),
    open: async () => current,
    send: async (_workerId, text) => {
      log.push(`send:${text}`)
    },
    abort: async () => {
      log.push('abort')
    },
    clearQueue: async () => {
      log.push('queue-clear')
    },
    respond: async (_workerId, approvalId, allow) => {
      log.push(`approval:${approvalId}:${allow}`)
    },
    subscribe: () => () => undefined
  }
}

async function request(
  port: number,
  path: string,
  init: { method?: string; body?: unknown; token?: string; host?: string } = {}
) {
  const headers: Record<string, string> = { host: init.host ?? `127.0.0.1:${port}` }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (init.token) headers.authorization = `Bearer ${init.token}`
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

describe('mobile gateway http', () => {
  const servers: MobileGatewayServer[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()))
  })

  it('binds loopback, rejects unpaired session reads, then pairs and drives chat commands', async () => {
    const devices: PairedDeviceRecord[] = []
    const pairing = new MobilePairingStore({
      load: () => devices,
      save: (next) => {
        devices.length = 0
        devices.push(...next)
      }
    })
    const log: string[] = []
    const bound: string[] = []
    const gateway = new MobileGatewayServer({
      pairing,
      sessions: fakeSessions(log),
      port: 18765,
      lanAddress: () => null,
      listen: async (server, port, host) => {
        bound.push(host)
        assertGatewayBindAddress(host)
        await new Promise<void>((resolve, reject) => {
          server.listen(port, host, () => resolve())
          server.on('error', reject)
        })
      }
    })
    servers.push(gateway)
    await gateway.start()
    expect(bound).toEqual(['127.0.0.1'])
    const denied = await request(18765, '/api/sessions')
    expect(denied.status).toBe(401)
    const offer = pairing.createOffer()
    const paired = await request(18765, '/api/pair', {
      method: 'POST',
      body: { token: offer.token, deviceName: 'Pixel' }
    })
    expect(paired.status).toBe(200)
    const token = paired.data.deviceToken as string
    const list = await request(18765, '/api/sessions', { token })
    expect(list.status).toBe(200)
    expect(list.data.live[0].title).toBe('hello')
    const send = await request(18765, '/api/sessions/worker-1/send', {
      method: 'POST',
      token,
      body: { text: 'hi', sessionId: 'sess-1', generation: 2 }
    })
    expect(send.status).toBe(200)
    expect(log).toContain('send:hi')
    pairing.revoke(paired.data.deviceId)
    const after = await request(18765, '/api/sessions', { token })
    expect(after.status).toBe(401)
  })

  it('rejects unknown Host headers to limit DNS rebinding', async () => {
    const devices: PairedDeviceRecord[] = []
    const pairing = new MobilePairingStore({
      load: () => devices,
      save: (next) => {
        devices.length = 0
        devices.push(...next)
      }
    })
    const gateway = new MobileGatewayServer({
      pairing,
      sessions: fakeSessions([]),
      port: 18766,
      lanAddress: () => null
    })
    servers.push(gateway)
    await gateway.start()
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: 18766, path: '/', headers: { host: 'evil.example:18766' } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(421)
  })
})
