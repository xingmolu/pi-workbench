import { describe, expect, it, vi } from 'vitest'
import { probeTailscale } from './mobile-tailscale'

describe('tailscale probe', () => {
  it('reads MagicDNS and a Serve URL from CLI JSON', async () => {
    const exec = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'status') {
        return {
          stdout: JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: 'macbook.tail123.ts.net.', Online: true }
          })
        }
      }
      return {
        stdout: JSON.stringify({
          TCP: { '443': { HTTPS: true, Handler: { Proxy: 'http://127.0.0.1:43124' } } },
          Foreground: {},
          BackendState: 'Running',
          URL: 'https://macbook.tail123.ts.net'
        })
      }
    })
    const status = await probeTailscale(exec as never)
    expect(status.available).toBe(true)
    expect(status.magicDns).toBe('macbook.tail123.ts.net')
    expect(status.serveUrl).toBe('https://macbook.tail123.ts.net')
  })

  it('explains a missing CLI without throwing', async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' })
    })
    const status = await probeTailscale(exec as never)
    expect(status.available).toBe(false)
    expect(status.error).toMatch(/Tailscale CLI/)
  })
})
