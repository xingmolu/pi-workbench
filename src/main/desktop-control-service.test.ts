import { describe, expect, it, vi } from 'vitest'
import { DesktopControlService } from './desktop-control-service'
import type { DesktopCapturerSourceInput } from './desktop-control-capture'
import { DESKTOP_CONTROL_LIMITS } from '../shared/desktop-control'

const PNG = 'data:image/png;base64,AAAA'

function source(id: string, name: string): DesktopCapturerSourceInput {
  return {
    id,
    name,
    thumbnail: {
      isEmpty: () => false,
      getSize: () => ({
        width: DESKTOP_CONTROL_LIMITS.thumbnailWidth,
        height: DESKTOP_CONTROL_LIMITS.thumbnailHeight
      }),
      toDataURL: () => PNG
    }
  }
}

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
  ],
  nodeCount: 2,
  truncated: false
}

function service(options: {
  platform?: string
  status?: string
  trusted?: boolean
  sources?: DesktopCapturerSourceInput[]
  locked?: boolean
  execImpl?: (source: string) => Promise<{ stdout: string }>
}): {
  getSources: ReturnType<typeof vi.fn>
  exec: ReturnType<typeof vi.fn>
  api: DesktopControlService
} {
  const getSources = vi.fn(async () => options.sources ?? [source('screen:0:0', 'Display')])
  const exec = vi.fn(async (_file: string, args: readonly string[]) => {
    const script = String(args[3] ?? '')
    if (options.execImpl) return options.execImpl(script)
    if (script.includes('CGSSessionScreenIsLocked')) {
      return { stdout: JSON.stringify({ ok: true, locked: options.locked === true }) }
    }
    if (script.includes('kCGEventLeftMouseDown') || script.includes('kCGEventMouseMoved')) {
      return { stdout: JSON.stringify({ ok: true, x: 12, y: 12 }) }
    }
    if (script.includes('keystroke')) return { stdout: JSON.stringify({ ok: true }) }
    return { stdout: JSON.stringify(dumpPayload) }
  })
  return {
    getSources,
    exec,
    api: new DesktopControlService({
      platform: options.platform ?? 'darwin',
      getMediaAccessStatus: () => options.status ?? 'granted',
      getSources,
      isTrustedAccessibilityClient: () => options.trusted ?? true,
      exec,
      openExternal: async () => undefined
    })
  }
}

describe('DesktopControlService', () => {
  it('keeps Linux unsupported and never calls capturer or osascript', async () => {
    const { api, getSources, exec } = service({ platform: 'linux' })
    expect(await api.dispatch({ type: 'permission' })).toMatchObject({
      permission: { access: 'unsupported' }
    })
    expect(await api.dispatch({ type: 'accessibility-permission' })).toMatchObject({
      permission: { access: 'unsupported' }
    })
    expect(await api.dispatch({ type: 'accessibility-dump' })).toMatchObject({
      dump: null,
      probed: false
    })
    expect(await api.dispatch({ type: 'input-preview', x: 1, y: 1 })).toMatchObject({
      allowed: false
    })
    await expect(api.executeAgent({ action: 'dump' })).rejects.toThrow(/macOS/)
    expect(getSources).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
  })

  it('returns AX dump to the agent without screenshot bytes', async () => {
    const { api } = service({})
    const result = await api.executeAgent({ action: 'dump' })
    expect(result).toMatchObject({ kind: 'dump', dump: { app: 'Finder' } })
    expect(JSON.stringify(result)).not.toContain('data:image')
    const hit = await api.executeAgent({ action: 'hit_test', x: 12, y: 12 })
    expect(hit).toMatchObject({
      kind: 'hit-test',
      target: { role: 'button', title: 'OK' }
    })
  })

  it('refuses agent input on a locked session even when TCC looks granted', async () => {
    const { api, exec } = service({ locked: true })
    await expect(api.executeAgent({ action: 'click', x: 12, y: 12 })).rejects.toThrow(/锁定/)
    expect(exec.mock.calls.some((call) => String(call[1]?.[3]).includes('kCGEventLeftMouseDown'))).toBe(
      false
    )
  })

  it('dispatches a confirmed settings click after probing both permissions', async () => {
    const { api } = service({})
    const clicked = await api.dispatch({
      type: 'input-click',
      x: 12,
      y: 12,
      confirmed: true
    })
    expect(clicked).toMatchObject({ type: 'input-click', executed: true, x: 12, y: 12 })
    await expect(api.dispatch({ type: 'input-click', x: 12, y: 12 } as never)).rejects.toThrow()
  })

  it('types after the same hard gates as click', async () => {
    const { api } = service({})
    await expect(api.executeAgent({ action: 'type', text: 'hello' })).resolves.toMatchObject({
      kind: 'action',
      action: 'type'
    })
  })
})
