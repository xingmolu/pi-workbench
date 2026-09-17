import { describe, expect, it, vi } from 'vitest'
import { DesktopAccessibility } from './desktop-control-accessibility'
import { ACCESSIBILITY_SETTINGS_URLS } from '../shared/desktop-control'
import type { JxaExec } from './desktop-control-jxa'

const dumpPayload = {
  ok: true,
  app: 'Finder',
  bundleId: 'com.apple.finder',
  windows: [
    {
      role: 'window',
      title: 'Desktop',
      value: '',
      description: '',
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      children: []
    }
  ],
  nodeCount: 1,
  truncated: false
}

function accessibility(options: {
  platform?: string
  trusted?: boolean | (() => boolean)
  exec?: JxaExec
  openExternal?: (url: string) => Promise<void>
}): {
  exec: ReturnType<typeof vi.fn<JxaExec>>
  openExternal: ReturnType<typeof vi.fn>
  isTrustedAccessibilityClient: ReturnType<typeof vi.fn>
  api: DesktopAccessibility
} {
  const exec = vi.fn<JxaExec>(
    options.exec ??
      (async (_file, args) => {
        const source = String(args[3] ?? '')
        if (source.includes('CGSSessionScreenIsLocked')) {
          return { stdout: JSON.stringify({ ok: true, locked: false }) }
        }
        return { stdout: JSON.stringify(dumpPayload) }
      })
  )
  const openExternal = vi.fn(options.openExternal ?? (async () => undefined))
  const isTrustedAccessibilityClient = vi.fn(() =>
    typeof options.trusted === 'function' ? options.trusted() : (options.trusted ?? true)
  )
  return {
    exec,
    openExternal,
    isTrustedAccessibilityClient,
    api: new DesktopAccessibility({
      platform: options.platform ?? 'darwin',
      isTrustedAccessibilityClient,
      exec,
      openExternal
    })
  }
}

describe('DesktopAccessibility', () => {
  it('reports unsupported on non-macOS and never runs JXA or opens settings', async () => {
    const { api, exec, openExternal, isTrustedAccessibilityClient } = accessibility({
      platform: 'linux',
      trusted: true
    })
    expect(api.readPermission()).toMatchObject({
      platformSupported: false,
      access: 'unsupported',
      canCapture: false,
      canOpenSettings: false
    })
    expect(isTrustedAccessibilityClient).not.toHaveBeenCalled()
    expect(await api.dump()).toMatchObject({
      type: 'accessibility-dump',
      dump: null,
      probed: false,
      message: expect.stringContaining('macOS')
    })
    expect(exec).not.toHaveBeenCalled()
    expect(await api.openSettings()).toMatchObject({ opened: false })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('maps trusted clients to granted and untrusted to pending before probing', () => {
    expect(accessibility({ trusted: true }).api.readPermission()).toMatchObject({
      access: 'granted',
      mediaAccessStatus: 'granted',
      canCapture: true
    })
    expect(accessibility({ trusted: false }).api.readPermission()).toMatchObject({
      access: 'pending',
      mediaAccessStatus: 'not-determined',
      canCapture: true
    })
  })

  it('probes the AX tree and upgrades pending TCC when nodes exist', async () => {
    const { api, exec } = accessibility({ trusted: false })
    const result = await api.dump()
    expect(exec).toHaveBeenCalled()
    expect(result).toMatchObject({
      type: 'accessibility-dump',
      probed: true,
      permission: { access: 'granted', mediaAccessStatus: 'not-determined' },
      dump: { app: 'Finder', nodeCount: 1 }
    })
  })

  it('fails closed when the session lock script errors', async () => {
    const { api } = accessibility({
      exec: vi.fn(async () => {
        throw new Error('osascript missing')
      })
    })
    expect(await api.sessionUnlocked()).toBe(false)
    expect(await api.dump()).toMatchObject({
      probed: true,
      dump: null,
      sessionUnlocked: false
    })
  })

  it('opens the Accessibility privacy pane and falls back', async () => {
    const first = accessibility({
      openExternal: async (url) => {
        if (url === ACCESSIBILITY_SETTINGS_URLS[0]) throw new Error('legacy missing')
      }
    })
    expect(await first.api.openSettings()).toMatchObject({
      opened: true,
      url: ACCESSIBILITY_SETTINGS_URLS[1]
    })
  })
})
