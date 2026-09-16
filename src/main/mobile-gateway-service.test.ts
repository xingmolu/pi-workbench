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
