import { afterEach, describe, expect, it } from 'vitest'
import { request as httpRequest } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    model: base.activeModel,
    nodes: base.nodes
  }
}

function fakeSessions(log: string[]): MobileSessionBridge {
  const current = snapshot('worker-1')
  const catalog: MobileCatalogProject[] = [
    {
      path: '/project',
      name: 'project',
      sessions: [
        {
          path: '/s.jsonl',
          title: '旧会话2026-09-15T14:40:19.201Z',
          modified: '2026-09-15T14:40:19.201Z',
          status: 'idle'
        }
      ]
    }
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
    open: async (cwd, sessionPath, model) => {
      log.push(
        `open:${cwd}:${sessionPath ?? 'new'}:${model ? `${model.providerId}/${model.modelId}` : ''}`
      )
      return current
    },
    send: async (_workerId, text, _sessionId, _generation, images) => {
      log.push(`send:${text}${images ? `+${images.length}img` : ''}`)
    },
    setModel: async (_workerId, identity, providerId, modelId) => {
      log.push(`model:${identity.sessionId}:${providerId}/${modelId}`)
    },
    setPermission: async (_workerId, mode) => {
      log.push(`permission:${mode}`)
    },
    setThinking: async (_workerId, identity, level) => {
      log.push(`thinking:${identity.sessionId}:${level}`)
    },
    skills: async () => [
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'review',
        description: 'Review code',
        scope: 'user',
        origin: 'top-level',
        mode: 'model-and-manual',
        canInsert: true
      }
    ],
    checkpointPlan: async (_workerId, _identity, entryId) => ({
      entryId,
      laterTurns: 0,
      files: [{ path: '/project/a.ts', action: 'restore', status: 'ready' }]
    }),
    checkpointRestore: async (_workerId, _identity, _entryId, force) => {
      log.push(`restore:${force}`)
      return { status: 'restored', restored: 1, skipped: [], failed: [] }
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

  it('delivers the initial snapshot and coalesces a burst into the final SSE snapshot', async () => {
    let devices: PairedDeviceRecord[] = []
    const pairing = new MobilePairingStore({
      load: () => devices,
      save: (next) => {
        devices = next
      }
    })
    const sessions = fakeSessions([])
    let publish: Parameters<MobileSessionBridge['subscribe']>[0] | undefined
    sessions.subscribe = (listener) => {
      publish = listener
      return () => {
        publish = undefined
      }
    }
    const gateway = new MobileGatewayServer({
      pairing,
      sessions,
      port: 18768,
      lanAddress: () => null
    })
    servers.push(gateway)
    await gateway.start()
    const paired = await request(18768, '/api/pair', {
      method: 'POST',
      body: { token: pairing.createOffer().token, deviceName: 'test' }
    })
    const response = await fetch('http://127.0.0.1:18768/api/sessions/worker-1/events', {
      headers: { authorization: `Bearer ${paired.data.deviceToken}` }
    })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const readUntil = async (marker: string): Promise<string> => {
      let text = ''
      while (!text.includes(marker)) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error('SSE ended before expected event')
        text += decoder.decode(chunk.value, { stream: true })
      }
      return text
    }
    try {
      expect(await readUntil('\n\n')).toContain('"revision":4')
      for (let revision = 5; revision <= 20; revision++)
        publish!({
          workerId: 'worker-1',
          snapshot: { ...snapshot('worker-1'), revision, busy: true, status: 'running' },
          runFinished: false
        })
      publish!({
        workerId: 'worker-1',
        snapshot: { ...snapshot('worker-1'), revision: 21 },
        runFinished: true
      })
      const final = await readUntil('event: run-finished')
      expect(final).toContain('"revision":21')
      expect(final.match(/event: snapshot/g)).toHaveLength(1)
      expect(final.indexOf('event: snapshot')).toBeLessThan(final.indexOf('event: run-finished'))
    } finally {
      await reader.cancel()
    }
  })

  it('rejects unknown workers and capacity excess before SSE headers, then reuses closed slots', async () => {
    let devices: PairedDeviceRecord[] = []
    const pairing = new MobilePairingStore({
      load: () => devices,
      save: (next) => {
        devices = next
      }
    })
    const gateway = new MobileGatewayServer({
      pairing,
      sessions: fakeSessions([]),
      port: 18770,
      lanAddress: () => null,
      maxConnectionsPerDevice: 1,
      maxConnections: 2
    })
    servers.push(gateway)
    await gateway.start()
    const grants = [
      pairing.pair(pairing.createOffer().token, 'one'),
      pairing.pair(pairing.createOffer().token, 'two'),
      pairing.pair(pairing.createOffer().token, 'three')
    ]
    const connect = (device = 0, worker = 'worker-1') =>
      fetch(`http://127.0.0.1:18770/api/sessions/${worker}/events`, {
        headers: { authorization: `Bearer ${grants[device].deviceToken}` }
      })
    const missing = await connect(0, 'missing')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-type')).toContain('application/json')
    const first = await connect()
    expect(first.status).toBe(200)
    const duplicate = await connect()
    expect(duplicate.status).toBe(429)
    expect(duplicate.headers.get('content-type')).toContain('application/json')
    const second = await connect(1)
    expect(second.status).toBe(200)
    expect((await connect(2)).status).toBe(429)
    expect(gateway.getDiagnostics()).toEqual({ connections: 2, blocked: 0, pendingSnapshots: 0 })
    await first.body!.cancel()
    for (let i = 0; i < 30 && gateway.getDiagnostics().connections !== 1; i++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    const reused = await connect()
    expect(reused.status).toBe(200)
    await Promise.all([second.body!.cancel(), reused.body!.cancel()])
    await gateway.stop()
    expect(gateway.getDiagnostics()).toEqual({ connections: 0, blocked: 0, pendingSnapshots: 0 })
  })

  it('ends oversized SSE with a recovery notice while HTTP retains the complete snapshot', async () => {
    let devices: PairedDeviceRecord[] = []
    const pairing = new MobilePairingStore({
      load: () => devices,
      save: (next) => {
        devices = next
      }
    })
    const sessions = fakeSessions([])
    const large = {
      ...snapshot('worker-1'),
      nodes: [{ id: 'u1', type: 'user' as const, text: '界'.repeat(2000) }]
    }
    sessions.snapshot = () => large
    const gateway = new MobileGatewayServer({
      pairing,
      sessions,
      port: 18771,
      lanAddress: () => null,
      snapshotStream: { maxFrameBytes: 1024 }
    })
    servers.push(gateway)
    await gateway.start()
    const grant = pairing.pair(pairing.createOffer().token, 'oversize')
    const headers = { authorization: `Bearer ${grant.deviceToken}` }
    const response = await fetch('http://127.0.0.1:18771/api/sessions/worker-1/events', { headers })
    expect(await response.text()).toBe('event: resync-required\ndata: {"workerId":"worker-1"}\n\n')
    const full = await request(18771, '/api/sessions/worker-1', { token: grant.deviceToken })
    expect(full.data).toEqual(large)
    await gateway.stop()
    expect(gateway.getDiagnostics().connections).toBe(0)
  })

  it('stops promptly with an unread backpressured SSE connection', async () => {
    let devices: PairedDeviceRecord[] = []
    const pairing = new MobilePairingStore({
      load: () => devices,
      save: (next) => {
        devices = next
      }
    })
    const sessions = fakeSessions([])
    sessions.snapshot = () => ({
      ...snapshot('worker-1'),
      nodes: [{ id: 'u1', type: 'user', text: 'x'.repeat(4 * 1024 * 1024) }]
    })
    const gateway = new MobileGatewayServer({
      pairing,
      sessions,
      port: 18772,
      lanAddress: () => null
    })
    servers.push(gateway)
    await gateway.start()
    const grant = pairing.pair(pairing.createOffer().token, 'unread')
    const client = httpRequest('http://127.0.0.1:18772/api/sessions/worker-1/events', {
      headers: { authorization: `Bearer ${grant.deviceToken}` }
    })
    client.on('error', () => {})
    const connected = new Promise<void>((resolve) =>
      client.on('response', (response) => {
        expect(response.statusCode).toBe(200)
        response.pause()
        resolve()
      })
    )
    client.end()
    await connected
    const stop = gateway.stop()
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        stop,
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('stop hung')), 1000)
        })
      ])
      expect(gateway.getDiagnostics()).toEqual({ connections: 0, blocked: 0, pendingSnapshots: 0 })
    } finally {
      clearTimeout(deadline)
      client.destroy()
    }
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
    expect(JSON.stringify(list.data.groups)).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(list.data.groups[0].sessions[0].title).toBe('hello')
    expect(list.data.groups[0].sessions[0].timeLabel).not.toMatch(/T|Z/)
    const conversation = await request(18765, '/api/sessions/worker-1', { token })
    expect(conversation.status).toBe(200)
    expect(conversation.data.model).toBe('offline')
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

  it('starts sessions, switches model and permission, lists skills, undoes turns and sends images', async () => {
    const devices: PairedDeviceRecord[] = []
    const pairing = new MobilePairingStore({
      load: () => devices,
      save: (next) => {
        devices.length = 0
        devices.push(...next)
      }
    })
    const log: string[] = []
    const gateway = new MobileGatewayServer({
      pairing,
      sessions: fakeSessions(log),
      port: 18794,
      lanAddress: () => null
    })
    servers.push(gateway)
    await gateway.start()
    const offer = pairing.createOffer()
    const paired = await request(18794, '/api/pair', {
      method: 'POST',
      body: { token: offer.token, deviceName: 'Pixel' }
    })
    const token = paired.data.deviceToken as string
    const identity = { sessionId: 'sess-1', generation: 2 }
    const post = (path: string, body: unknown): ReturnType<typeof request> =>
      request(18794, path, { method: 'POST', token, body })

    expect(
      (await post('/api/sessions/new', { cwd: '/project', providerId: 'p', modelId: 'm' })).status
    ).toBe(200)
    expect(
      (await post('/api/sessions/worker-1/model', { ...identity, providerId: 'p', modelId: 'm2' }))
        .status
    ).toBe(200)
    expect((await post('/api/sessions/worker-1/permission', { mode: 'auto' })).status).toBe(200)
    expect((await post('/api/sessions/worker-1/permission', { mode: 'root' })).status).toBe(400)
    expect(
      (await post('/api/sessions/worker-1/thinking', { ...identity, level: 'high' })).status
    ).toBe(200)
    expect(
      (await post('/api/sessions/worker-1/thinking', { ...identity, level: 'ultra' })).status
    ).toBe(400)
    const skills = await post('/api/sessions/worker-1/skills', identity)
    expect(skills.data.skills.map((skill: { name: string }) => skill.name)).toEqual(['review'])
    const plan = await post('/api/sessions/worker-1/checkpoint', { ...identity, entryId: 'e1' })
    expect(plan.data.plan.files).toHaveLength(1)
    const restored = await post('/api/sessions/worker-1/checkpoint', {
      ...identity,
      entryId: 'e1',
      restore: true,
      force: false
    })
    expect(restored.data.outcome.status).toBe('restored')
    const image = { mimeType: 'image/png', data: 'iVBORw0KGgo=' }
    expect(
      (await post('/api/sessions/worker-1/send', { ...identity, text: '', images: [image] })).status
    ).toBe(200)
    expect(
      (
        await post('/api/sessions/worker-1/send', {
          ...identity,
          text: 'x',
          images: [{ mimeType: 'image/svg+xml', data: 'PHN2Zz4=' }]
        })
      ).status
    ).toBe(400)
    expect((await post('/api/sessions/worker-1/send', { ...identity, text: '  ' })).status).toBe(
      400
    )
    expect(log).toEqual([
      'open:/project:new:p/m',
      'model:sess-1:p/m2',
      'permission:auto',
      'thinking:sess-1:high',
      'restore:false',
      'send:+1img'
    ])
  })

  it('serves remote views under the desktop access level: off, view only, control', async () => {
    const devices: PairedDeviceRecord[] = []
    const pairing = new MobilePairingStore({
      load: () => devices,
      save: (next) => {
        devices.length = 0
        devices.push(...next)
      }
    })
    let access: 'off' | 'view' | 'control' = 'off'
    const inputs: unknown[] = []
    const gateway = new MobileGatewayServer({
      pairing,
      sessions: fakeSessions([]),
      port: 18795,
      lanAddress: () => null,
      views: {
        access: () => access,
        list: () => [{ id: 'browser', kind: 'browser', title: '浏览器', live: true }],
        subscribe: (id, send) => {
          if (id !== 'browser') return null
          send('frame', { data: 'AAAA', width: 10, height: 10 })
          return () => undefined
        },
        input: async (_id, input) => {
          inputs.push(input)
        }
      }
    })
    servers.push(gateway)
    await gateway.start()
    const offer = pairing.createOffer()
    const paired = await request(18795, '/api/pair', {
      method: 'POST',
      body: { token: offer.token, deviceName: 'Pixel' }
    })
    const token = paired.data.deviceToken as string
    const tap = (): ReturnType<typeof request> =>
      request(18795, '/api/views/browser/input', {
        method: 'POST',
        token,
        body: { type: 'tap', x: 1, y: 1 }
      })
    expect((await request(18795, '/api/views', { token })).data).toEqual({
      access: 'off',
      views: []
    })
    expect((await tap()).status).toBe(403)
    access = 'view'
    expect((await request(18795, '/api/views', { token })).data.views).toHaveLength(1)
    expect((await tap()).status).toBe(403)
    const events = await fetch('http://127.0.0.1:18795/api/views/browser/events', {
      headers: { authorization: `Bearer ${token}` }
    })
    expect(events.headers.get('content-type')).toContain('text/event-stream')
    const reader = events.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('event: frame')
    await reader.cancel()
    access = 'control'
    expect((await tap()).status).toBe(200)
    expect(inputs).toEqual([{ type: 'tap', x: 1, y: 1 }])
    expect(
      (await request(18795, '/api/views/browser/input', { method: 'POST', body: {} })).status
    ).toBe(401)
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

  it('serves the built mobile page and its assets without pairing', async () => {
    const webRoot = mkdtempSync(join(tmpdir(), 'pi-mobile-root-'))
    mkdirSync(join(webRoot, 'assets'))
    writeFileSync(
      join(webRoot, 'mobile.html'),
      '<script type="module" src="./assets/mobile-x1.js"></script>'
    )
    writeFileSync(join(webRoot, 'assets', 'mobile-x1.js'), 'console.log(1)')
    const pairing = new MobilePairingStore({ load: () => [], save: () => undefined })
    const gateway = new MobileGatewayServer({
      pairing,
      sessions: fakeSessions([]),
      port: 18767,
      lanAddress: () => null,
      webRoot
    })
    servers.push(gateway)
    await gateway.start()
    try {
      const page = await fetch('http://127.0.0.1:18767/')
      expect(page.status).toBe(200)
      expect(page.headers.get('content-security-policy')).toContain("script-src 'self'")
      expect(await page.text()).toContain('mobile-x1.js')
      const script = await fetch('http://127.0.0.1:18767/assets/mobile-x1.js')
      expect(script.status).toBe(200)
      expect(script.headers.get('content-type')).toContain('javascript')
      expect((await fetch('http://127.0.0.1:18767/assets/nope.js')).status).toBe(404)
    } finally {
      rmSync(webRoot, { recursive: true, force: true })
    }
  })

  it('explains an unbuilt mobile page instead of failing silently', async () => {
    const pairing = new MobilePairingStore({ load: () => [], save: () => undefined })
    const gateway = new MobileGatewayServer({
      pairing,
      sessions: fakeSessions([]),
      port: 18793,
      lanAddress: () => null,
      webRoot: join(tmpdir(), 'pi-mobile-missing-root')
    })
    servers.push(gateway)
    await gateway.start()
    const page = await fetch('http://127.0.0.1:18793/')
    expect(page.status).toBe(503)
    expect(await page.text()).toContain('npm run build')
  })

  it('encodes a Tailscale Serve URL in the pairing QR instead of LAN-only', () => {
    const pairing = new MobilePairingStore({
      load: () => [],
      save: () => undefined
    })
    const gateway = new MobileGatewayServer({
      pairing,
      sessions: fakeSessions([]),
      lanAddress: () => '192.168.1.20'
    })
    const offer = pairing.createOffer()
    const payload = gateway.pairingPayload(
      offer.token,
      offer.expiresAt,
      `https://macbook.tail123.ts.net/?pair=${offer.token}`
    )
    expect(payload.url).toBe(`https://macbook.tail123.ts.net/?pair=${offer.token}`)
    expect(payload.qrSvg).toContain('<svg')
    expect(payload.url).not.toMatch(/192\.168/)
  })
})
