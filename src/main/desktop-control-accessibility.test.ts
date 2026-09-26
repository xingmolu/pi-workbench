import { describe, expect, it, vi } from 'vitest'
import { DesktopAccessibility } from './desktop-control-accessibility'
import { ACCESSIBILITY_SETTINGS_URLS } from '../shared/desktop-control'
import { MacComputerUseBridge, type NativeComputerUseExec } from './desktop-control-native'

const dumpPayload = {
  ok: true,
  app: 'Finder',
  bundleId: 'com.apple.finder',
  target: {
    pid: 42,
    windowId: 77,
    app: 'Finder',
    bundleId: 'com.apple.finder',
    frame: { x: 0, y: 0, width: 100, height: 80 }
  },
  windows: [
    {
      role: 'window',
      windowId: 77,
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
        if (command.action === 'foreground-window') {
          return { stdout: JSON.stringify({ ok: true, target: dumpPayload.target }) }
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
      appBundlePath: '/test/Pi Desktop.app',
      openExternal
    })
  }
}

describe('DesktopAccessibility', () => {
  it('reads and validates the foreground window identity independently from AX', async () => {
    const { api, exec } = accessibility({ trusted: false })
    await expect(api.foregroundWindow()).resolves.toEqual(dumpPayload.target)
    expect(exec.mock.calls).toHaveLength(1)
    exec.mockResolvedValueOnce({ stdout: JSON.stringify({ ok: true, target: { windowId: 0 } }) })
    await expect(api.foregroundWindow()).rejects.toThrow('目标窗口')
  })

  it('attaches the focused native window identity to the AX dump', async () => {
    const { api } = accessibility({ trusted: true })
    expect(await api.dump()).toMatchObject({
      dump: { target: dumpPayload.target, windows: [{ windowId: 77, title: 'Desktop' }] }
    })
  })

  it('accepts a foreground process without bundle metadata', async () => {
    const { api, exec } = accessibility({ trusted: true })
    exec.mockResolvedValueOnce({
      stdout: JSON.stringify({
        ok: true,
        target: {
          ...dumpPayload.target,
          app: '',
          bundleId: ''
        }
      })
    })
    await expect(api.foregroundWindow()).resolves.toMatchObject({ bundleId: '' })
  })

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

    const untrusted = accessibility({ trusted: false })
    expect(await untrusted.api.probePermission(false)).toMatchObject({
      access: 'denied',
      mediaAccessStatus: 'denied'
    })
    expect(
      untrusted.exec.mock.calls.some((call) => {
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

  it('reports untrusted permission with the actual running bundle path', async () => {
    const { api } = accessibility({ trusted: false })
    expect(await api.dump()).toMatchObject({
      type: 'accessibility-dump',
      dump: null,
      probed: true,
      permission: { access: 'denied' },
      message: expect.stringContaining('/test/Pi Desktop.app')
    })
  })

  it('fails closed when native session-lock probing errors', async () => {
    const { api } = accessibility({
      exec: vi.fn(async () => {
        throw new Error('native helper missing')
      })
    })
    await expect(api.sessionUnlocked()).rejects.toThrow('原生助手执行失败')
    await expect(api.dump()).rejects.toThrow('原生助手执行失败')
  })

  it('clears previous trust and surfaces malformed permission responses', async () => {
    const { api, exec } = accessibility({ trusted: true })
    expect((await api.probePermission()).access).toBe('granted')
    exec.mockResolvedValueOnce({ stdout: JSON.stringify({ ok: true }) })
    await expect(api.probePermission()).rejects.toThrow('无效的权限状态')
    expect(api.readPermission().access).not.toBe('granted')
  })

  it('never treats a missing lock field as an unlocked desktop', async () => {
    const { api } = accessibility({ exec: async () => ({ stdout: '{"ok":true}' }) })
    await expect(api.sessionUnlocked()).rejects.toThrow('无效的锁屏状态')
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
