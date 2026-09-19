import { describe, expect, it, vi } from 'vitest'
import { DesktopInput, inputGateMessage } from './desktop-control-input'
import type { AxDump, DesktopControlPermission } from '../shared/desktop-control'

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

describe('DesktopInput', () => {
  it('refuses non-darwin, locked, and ungranted sessions without JXA', async () => {
    const exec = vi.fn()
    const linux = new DesktopInput({ platform: 'linux', exec })
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
    expect(exec).not.toHaveBeenCalled()
    expect(
      inputGateMessage({
        platformSupported: true,
        sessionUnlocked: false,
        accessibilityGranted: true
      })
    ).toContain('锁定')
  })

  it('hit-tests before a confirmed click and posts CGEvent JXA', async () => {
    const exec = vi.fn(async () => ({ stdout: JSON.stringify({ ok: true, x: 12, y: 12 }) }))
    const api = new DesktopInput({ platform: 'darwin', exec })
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
    expect(JSON.stringify(exec.mock.calls)).toContain('kCGEventLeftMouseDown')
    expect(JSON.stringify(exec.mock.calls)).toContain('12')
  })

  it('does not require screen recording for input but still requires accessibility', async () => {
    const exec = vi.fn(async () => ({ stdout: JSON.stringify({ ok: true, x: 1, y: 1 }) }))
    const api = new DesktopInput({ platform: 'darwin', exec })
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
    expect(exec).not.toHaveBeenCalled()
  })
})
