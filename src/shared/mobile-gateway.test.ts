import { describe, expect, it } from 'vitest'
import { mobileGatewayCommandSchema, mobileGatewayStateSchema } from './mobile-gateway'

describe('mobile gateway contracts', () => {
  it('accepts the desktop command union and a complete state snapshot', () => {
    expect(mobileGatewayCommandSchema.parse({ type: 'start' }).type).toBe('start')
    expect(
      mobileGatewayCommandSchema.parse({ type: 'clipboard:copy', text: 'https://mac.ts.net/' }).type
    ).toBe('clipboard:copy')
    expect(mobileGatewayCommandSchema.safeParse({ type: 'start', extra: true }).success).toBe(false)
    expect(
      mobileGatewayStateSchema.parse({
        running: false,
        port: null,
        loopbackUrl: null,
        lanUrl: null,
        lanAddress: null,
        pairing: null,
        devices: [],
        powerSave: false,
        tailscale: {
          available: false,
          online: false,
          magicDns: null,
          serveUrl: null,
          binary: null,
          error: null
        },
        error: null
      }).running
    ).toBe(false)
  })
})
