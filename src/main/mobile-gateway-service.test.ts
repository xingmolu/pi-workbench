import { describe, expect, it } from 'vitest'
import { MobileGatewayService } from './mobile-gateway-service'
import { MISSING_TAILSCALE_CLI, missingTailscaleStatus } from './mobile-tailscale'
import type { MobileSessionBridge } from './mobile-session-bridge'

function stubSessions(): MobileSessionBridge {
  return {
    listLive: () => [],
    listCatalog: async () => [],
    snapshot: () => null,
    open: async () => {
      throw new Error('unused')
    },
    send: async () => undefined,
    abort: async () => undefined,
    clearQueue: async () => undefined,
    respond: async () => undefined,
    setModel: async () => undefined,
    setPermission: async () => undefined,
    setThinking: async () => undefined,
    skills: async () => [],
    checkpointPlan: async () => null,
    checkpointRestore: async () => null,
    subscribe: () => () => undefined
  }
}

describe('mobile gateway service clipboard and tailscale errors', () => {
  it('copies text through the injected main-process clipboard', async () => {
    const written: string[] = []
    const service = new MobileGatewayService({
      devices: { load: () => [], save: () => undefined },
      sessions: stubSessions(),
      publish: () => undefined,
      writeClipboard: (text) => {
        written.push(text)
      },
      probeTailscale: async () => missingTailscaleStatus()
    })
    const state = await service.dispatch({
      type: 'clipboard:copy',
      text: 'https://macbook.tail123.ts.net/'
    })
    expect(written).toEqual(['https://macbook.tail123.ts.net/'])
    expect(state.error).toBeNull()
  })

  it('records a visible error when clipboard is unavailable', async () => {
    const service = new MobileGatewayService({
      devices: { load: () => [], save: () => undefined },
      sessions: stubSessions(),
      publish: () => undefined,
      probeTailscale: async () => missingTailscaleStatus()
    })
    const state = await service.dispatch({ type: 'clipboard:copy', text: 'hello' })
    expect(state.error).toMatch(/剪贴板/)
  })

  it('surfaces a missing Tailscale CLI on probe instead of staying silent', async () => {
    const service = new MobileGatewayService({
      devices: { load: () => [], save: () => undefined },
      sessions: stubSessions(),
      publish: () => undefined,
      probeTailscale: async () => missingTailscaleStatus()
    })
    const state = await service.dispatch({ type: 'tailscale:probe' })
    expect(state.tailscale.available).toBe(false)
    expect(state.tailscale.error).toBe(MISSING_TAILSCALE_CLI)
    expect(state.error).toBe(MISSING_TAILSCALE_CLI)
  })
})

describe('mobile preview window', () => {
  it('pairs the preview afresh each time and keeps a single preview device', async () => {
    let devices: import('../shared/mobile-gateway').PairedDeviceRecord[] = []
    const opened: string[] = []
    const service = new MobileGatewayService({
      devices: { load: () => devices, save: (next) => (devices = next) },
      sessions: stubSessions(),
      publish: () => undefined,
      port: 0,
      probeTailscale: async () => missingTailscaleStatus(),
      openPreview: (url) => opened.push(url)
    })
    try {
      await service.dispatch({ type: 'preview:open' })
      expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?pair=\w+/)
      const pair = (url: string): void => {
        service.pairing.pair(new URL(url).searchParams.get('pair')!, 'PiDesktopPreview (iPhone)')
      }
      pair(opened[0]!)
      service.pairing.pair(service.pairing.createOffer().token, 'iPhone')
      await service.dispatch({ type: 'preview:open' })
      pair(opened[1]!)
      expect(devices.map((device) => device.name).sort()).toEqual([
        'PiDesktopPreview (iPhone)',
        'iPhone'
      ])
    } finally {
      await service.dispatch({ type: 'stop' })
    }
  })
})
