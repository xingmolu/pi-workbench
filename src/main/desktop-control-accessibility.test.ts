import { describe, expect, it, vi } from 'vitest'
import { DesktopAccessibility } from './desktop-control-accessibility'
import { ACCESSIBILITY_SETTINGS_URLS } from '../shared/desktop-control'
import {
  MacComputerUseBridge,
  type NativeComputerUseExec
} from './desktop-control-native'

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
  trusted?: boolean
  exec?: NativeComputerUseExec
  openExternal?: (url: string) => Promise<void>
}): {
  exec: ReturnType<typeof vi.fn<NativeComputerUseExec>>
  openExternal: ReturnType<typeof vi.fn>
  api: DesktopAccessibility
} {
  const exec = vi.fn<NativeComputerUseExec>(
    options.exec ??
      (async (_file, args) => {
        const command = JSON.parse(String(args[0] ?? '{}')) as {
          action?: string
          prompt?: boolean
        }
        if (command.action === 'accessibility-permission') {
          return {
            stdout: JSON.stringify({ ok: true, trusted: options.trusted ?? true })
          }
        }
        if (command.action === 'session-lock') {
          return { stdout: JSON.stringify({ ok: true, locked: false }) }
        }
        return { stdout: JSON.stringify(dumpPayload) }
      })
  )
  const openExternal = vi.fn(options.openExternal ?? (async () => undefined))
  return {
    exec,
    openExternal,
    api: new DesktopAccessibility({
      platform: options.platform ?? 'darwin',
      bridge: new MacComputerUseBridge('/test/pi-computer-use-helper', exec),
      openExternal
    })
  }
}

describe('DesktopAccessibility', () => {
  it('reports unsupported on non-macOS and never runs the native helper or opens settings', async () => {
    const { api, exec, openExternal } = accessibility({
      platform: 'linux',
      trusted: true
    })
    expect(api.readPermission()).toMatchObject({
      platformSupported: false,
      access: 'unsupported',
      canCapture: false,
      canOpenSettings: false
    })
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

  it('uses the native helper as the source of truth for Accessibility permission', async () => {
    const granted = accessibility({ trusted: true })
    expect(await granted.api.probePermission(false)).toMatchObject({
      access: 'granted',
      mediaAccessStatus: 'granted'
    })

    const pending = accessibility({ trusted: false })
    expect(await pending.api.probePermission(false)).toMatchObject({
      access: 'pending',
      mediaAccessStatus: 'not-determined'
    })
    expect(
      pending.exec.mock.calls.some((call) => {
        const command = JSON.parse(String(call[1]?.[0] ?? '{}'))
        return command.action === 'accessibility-permission' && command.prompt === false
      })
    ).toBe(true)
  })

  it('requests the native Accessibility prompt when permission is missing', async () => {
    const exec = vi.fn<NativeComputerUseExec>(async (_file, args) => {
      const command = JSON.parse(String(args[0] ?? '{}')) as {
        action?: string
        prompt?: boolean
      }
      if (command.action === 'accessibility-permission') {
        return {
          stdout: JSON.stringify({
            ok: true,
            trusted: command.prompt === true
          })
        }
      }
      if (command.action === 'session-lock') {
        return { stdout: JSON.stringify({ ok: true, locked: false }) }
      }
      return { stdout: JSON.stringify(dumpPayload) }
    })
    const { api } = accessibility({ exec })
    const result = await api.dump()
    expect(result).toMatchObject({
      type: 'accessibility-dump',
      probed: true,
      permission: { access: 'granted' },
      dump: { app: 'Finder', nodeCount: 1 }
    })
    expect(
      exec.mock.calls.some((call) => {
        const command = JSON.parse(String(call[1]?.[0] ?? '{}'))
        return command.action === 'accessibility-permission' && command.prompt === true
      })
    ).toBe(true)
  })

  it('keeps permission pending when the native helper remains untrusted', async () => {
    const { api } = accessibility({ trusted: false })
    expect(await api.dump()).toMatchObject({
      type: 'accessibility-dump',
      dump: null,
      probed: true,
      permission: { access: 'pending' },
      message: expect.stringContaining('Pi Desktop 已请求')
    })
  })

  it('fails closed when native session-lock probing errors', async () => {
    const { api } = accessibility({
      exec: vi.fn(async () => {
        throw new Error('native helper missing')
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
