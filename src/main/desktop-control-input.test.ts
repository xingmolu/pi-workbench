import { describe, expect, it, vi } from 'vitest'
import { DesktopInput, inputGateMessage } from './desktop-control-input'
import type { AxDump, DesktopControlPermission } from '../shared/desktop-control'
import {
  MacComputerUseBridge,
  type NativeComputerUseExec
} from './desktop-control-native'

const granted: DesktopControlPermission = {
  platformSupported: true,
  mediaAccessStatus: 'granted',
  access: 'granted',
  canCapture: true,
  canOpenSettings: true
}

const dump: AxDump = {
  app: 'Finder',
  bundleId: 'com.apple.finder',
  nodeCount: 1,
  truncated: false,
  windows: [
    {
      role: 'window',
      title: 'Desktop',
      value: '',
      description: '',
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      children: [
        {
          role: 'button',
          title: 'OK',
          value: '',
          description: '',
          x: 10,
          y: 10,
          width: 40,
          height: 20,
          children: []
        }
      ]
    }
  ]
}

function bridge(
  exec = vi.fn<NativeComputerUseExec>(async () => ({ stdout: JSON.stringify({ ok: true }) }))
) {
  return { exec, bridge: new MacComputerUseBridge('/test/pi-computer-use-helper', exec) }
}

describe('DesktopInput', () => {
  it('refuses non-darwin, locked, and ungranted sessions without native calls', async () => {
    const native = bridge()
    const linux = new DesktopInput({ platform: 'linux', bridge: native.bridge })
    const preview = linux.preview({
      x: 12,
      y: 12,
      screen: granted,
      accessibility: granted,
      sessionUnlocked: true,
      dump
    })
    expect(preview.allowed).toBe(false)
    expect(preview.message).toContain('macOS')
    expect(
      (
        await linux.click({
          x: 12,
          y: 12,
          confirmed: true,
          screen: granted,
          accessibility: granted,
          sessionUnlocked: true,
          dump
        })
      ).executed
    ).toBe(false)
    expect(native.exec).not.toHaveBeenCalled()
    expect(
      inputGateMessage({
        platformSupported: true,
        sessionUnlocked: false,
        accessibilityGranted: true
      })
    ).toContain('锁定')
  })

  it('hit-tests before a confirmed click and calls the native helper', async () => {
    const native = bridge()
    const api = new DesktopInput({ platform: 'darwin', bridge: native.bridge })
    const preview = api.preview({
      x: 12,
      y: 12,
      screen: granted,
      accessibility: granted,
      sessionUnlocked: true,
      dump
    })
    expect(preview).toMatchObject({
      allowed: true,
      target: { role: 'button', title: 'OK' }
    })
    const clicked = await api.click({
      x: 12,
      y: 12,
      confirmed: true,
      screen: granted,
      accessibility: granted,
      sessionUnlocked: true,
      dump
    })
    expect(clicked.executed).toBe(true)
    expect(native.exec).toHaveBeenCalledOnce()
    const command = JSON.parse(String(native.exec.mock.calls[0]?.[1]?.[0] ?? '{}'))
    expect(command).toEqual({ action: 'click', x: 12, y: 12, button: 'left' })
  })

  it('does not require screen recording for input but still requires accessibility', async () => {
    const native = bridge()
    const api = new DesktopInput({ platform: 'darwin', bridge: native.bridge })
    const denied: DesktopControlPermission = { ...granted, access: 'denied', canCapture: false }
    expect(
      api.preview({
        x: 1,
        y: 1,
        screen: denied,
        accessibility: granted,
        sessionUnlocked: true,
        dump
      }).allowed
    ).toBe(true)
    expect(
      (
        await api.click({
          x: 1,
          y: 1,
          confirmed: true,
          screen: granted,
          accessibility: denied,
          sessionUnlocked: true,
          dump
        })
      ).executed
    ).toBe(false)
    expect(native.exec).not.toHaveBeenCalled()
  })
})
