import { describe, expect, it, vi } from 'vitest'
import {
  MISSING_TAILSCALE_CLI,
  disableTailscaleServe,
  enableTailscaleServe,
  probeTailscale,
  remotePairingUrl,
  resolveTailscaleBinary,
  tailscaleServeCommand
} from './mobile-tailscale'

const STATUS_JSON = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'macbook.tail123.ts.net.', Online: true }
})
const SERVE_JSON = JSON.stringify({
  TCP: { '443': { HTTPS: true, Handler: { Proxy: 'http://127.0.0.1:43124' } } },
  Foreground: {},
  BackendState: 'Running',
  URL: 'https://macbook.tail123.ts.net'
})

describe('tailscale binary resolution', () => {
  it('prefers Homebrew even when PATH has no tailscale', async () => {
    const found = await resolveTailscaleBinary({
      exists: (file) => file === '/opt/homebrew/bin/tailscale',
      envPath: '/usr/bin',
      platform: 'darwin',
      which: async () => null
    })
    expect(found).toBe('/opt/homebrew/bin/tailscale')
  })

  it('accepts the Tailscale.app CLI when Homebrew is absent', async () => {
    const found = await resolveTailscaleBinary({
      exists: (file) => file === '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      envPath: '/usr/bin',
      platform: 'darwin',
      which: async () => null
    })
    expect(found).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
  })

  it('falls back to which when candidates are missing', async () => {
    const found = await resolveTailscaleBinary({
      exists: (file) => file === '/tmp/custom/tailscale',
      envPath: '/usr/bin',
      platform: 'darwin',
      which: async () => '/tmp/custom/tailscale'
    })
    expect(found).toBe('/tmp/custom/tailscale')
  })

  it('returns null when nothing is executable', async () => {
    const found = await resolveTailscaleBinary({
      exists: () => false,
      envPath: '/usr/bin',
      platform: 'darwin',
      which: async () => null
    })
    expect(found).toBeNull()
  })

  it('finds tailscale.exe in Program Files or on PATH on Windows', async () => {
    const installed = 'C:\\Program Files\\Tailscale\\tailscale.exe'
    expect(
      await resolveTailscaleBinary({
        exists: (file) => file === installed,
        envPath: 'C:\\Windows',
        platform: 'win32',
        which: async () => null
      })
    ).toBe(installed)
    expect(
      await resolveTailscaleBinary({
        exists: (file) => file === 'D:\\tools\\tailscale.exe',
        envPath: 'C:\\Windows;D:\\tools',
        platform: 'win32',
        which: async () => null
      })
    ).toBe('D:\\tools\\tailscale.exe')
  })
})

describe('tailscale probe', () => {
  it('runs the resolved absolute binary rather than a PATH-dependent name', async () => {
    const exec = vi.fn(async (bin: string, args: string[]) => {
      expect(bin).toBe('/opt/homebrew/bin/tailscale')
      if (args[0] === 'status') return { stdout: STATUS_JSON }
      return { stdout: SERVE_JSON }
    })
    const status = await probeTailscale({
      exec: exec as never,
      exists: (file) => file === '/opt/homebrew/bin/tailscale',
      envPath: '/usr/bin',
      which: async () => null
    })
    expect(status.available).toBe(true)
    expect(status.magicDns).toBe('macbook.tail123.ts.net')
    expect(status.serveUrl).toBe('https://macbook.tail123.ts.net')
    expect(status.binary).toBe('/opt/homebrew/bin/tailscale')
    expect(exec.mock.calls.map((call) => call[0])).toEqual([
      '/opt/homebrew/bin/tailscale',
      '/opt/homebrew/bin/tailscale'
    ])
  })

  it('explains a missing CLI without throwing or spawning tailscale', async () => {
    const exec = vi.fn(async () => {
      throw new Error('should not spawn')
    })
    const status = await probeTailscale({
      exec: exec as never,
      exists: () => false,
      envPath: '/usr/bin',
      which: async () => null
    })
    expect(status.available).toBe(false)
    expect(status.binary).toBeNull()
    expect(status.error).toBe(MISSING_TAILSCALE_CLI)
    expect(exec).not.toHaveBeenCalled()
  })

  it('keeps the spawn error when a resolved binary itself fails', async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('spawn /opt/homebrew/bin/tailscale ENOENT'), { code: 'ENOENT' })
    })
    const status = await probeTailscale({
      exec: exec as never,
      resolveBinary: async () => '/opt/homebrew/bin/tailscale'
    })
    expect(status.available).toBe(false)
    expect(status.binary).toBe('/opt/homebrew/bin/tailscale')
    expect(status.error).toMatch(/ENOENT/)
  })
})

describe('tailscale serve', () => {
  it('enables Serve through the resolved binary and never Funnel', async () => {
    const calls: Array<[string, string[]]> = []
    const exec = vi.fn(async (bin: string, args: string[]) => {
      calls.push([bin, [...args]])
      if (args[0] === 'serve' && args[1] === '--bg') return { stdout: '' }
      if (args[0] === 'status') return { stdout: STATUS_JSON }
      return { stdout: SERVE_JSON }
    })
    const io = {
      exec: exec as never,
      exists: (file: string) => file === '/usr/local/bin/tailscale',
      envPath: '/usr/bin',
      which: async () => null
    }
    const status = await enableTailscaleServe(43124, io)
    expect(calls[0]).toEqual([
      '/usr/local/bin/tailscale',
      ['serve', '--bg', 'http://127.0.0.1:43124']
    ])
    expect(calls[0][1].join(' ')).not.toMatch(/funnel/i)
    expect(status.serveUrl).toBe('https://macbook.tail123.ts.net')
    expect(tailscaleServeCommand(43124, status.binary ?? 'tailscale')).toBe(
      '/usr/local/bin/tailscale serve --bg http://127.0.0.1:43124'
    )
  })

  it('returns the missing-CLI message instead of throwing when Serve cannot start', async () => {
    const status = await enableTailscaleServe(43124, {
      exists: () => false,
      envPath: '/usr/bin',
      which: async () => null
    })
    expect(status.available).toBe(false)
    expect(status.error).toBe(MISSING_TAILSCALE_CLI)
    const off = await disableTailscaleServe({
      exists: () => false,
      envPath: '/usr/bin',
      which: async () => null
    })
    expect(off.error).toBe(MISSING_TAILSCALE_CLI)
  })
})

describe('remote pairing URL', () => {
  it('prefers the Serve https://*.ts.net origin over MagicDNS', () => {
    expect(
      remotePairingUrl({
        serveUrl: 'https://macbook.tail123.ts.net/',
        magicDns: 'macbook.tail123.ts.net',
        token: 'ABCD2345'
      })
    ).toBe('https://macbook.tail123.ts.net/?pair=ABCD2345')
  })

  it('builds https MagicDNS when Serve is not yet on', () => {
    expect(
      remotePairingUrl({
        magicDns: 'iphone-host.tail123.ts.net.',
        token: 'ABCD2345'
      })
    ).toBe('https://iphone-host.tail123.ts.net/?pair=ABCD2345')
  })
})
