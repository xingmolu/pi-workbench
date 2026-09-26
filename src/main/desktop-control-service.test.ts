import { describe, expect, it, vi } from 'vitest'
import { ComputerUseService } from './computer-use-service'
import { DesktopControlService } from './desktop-control-service'
import type { DesktopCapturerSourceInput } from './desktop-control-capture'
import { DESKTOP_CONTROL_LIMITS } from '../shared/desktop-control'

const scope = { ownerId: 'test', sessionId: 'session', generation: 1 }

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
  target: {
    pid: 42,
    windowId: 77,
    app: 'Finder',
    bundleId: 'com.apple.finder',
    frame: { x: 0, y: 0, width: 200, height: 200 }
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
  execImpl?: (command: Record<string, unknown>) => Promise<{ stdout: string }>
}): {
  getSources: ReturnType<typeof vi.fn>
  exec: ReturnType<typeof vi.fn>
  api: DesktopControlService
} {
  const getSources = vi.fn(async () => options.sources ?? [source('screen:0:0', 'Display')])
  const exec = vi.fn(async (_file: string, args: readonly string[]) => {
    const command = JSON.parse(String(args[0] ?? '{}')) as Record<string, unknown>
    if (options.execImpl) return options.execImpl(command)
    if (command.action === 'accessibility-permission') {
      return { stdout: JSON.stringify({ ok: true, trusted: options.trusted ?? true }) }
    }
    if (command.action === 'session-lock') {
      return { stdout: JSON.stringify({ ok: true, locked: options.locked === true }) }
    }
    if (command.action === 'foreground-window') {
      return { stdout: JSON.stringify({ ok: true, target: dumpPayload.target }) }
    }
    if (command.action === 'click' || command.action === 'move') {
      return { stdout: JSON.stringify({ ok: true, x: command.x ?? 12, y: command.y ?? 12 }) }
    }
    if (command.action === 'type') return { stdout: JSON.stringify({ ok: true }) }
    return { stdout: JSON.stringify(dumpPayload) }
  })
  return {
    getSources,
    exec,
    api: new DesktopControlService({
      platform: options.platform ?? 'darwin',
      getMediaAccessStatus: () => options.status ?? 'granted',
      getSources,
      nativeHelperPath: '/test/pi-computer-use-helper',
      appBundlePath: '/test/Pi Desktop.app',
      nativeExec: exec,
      openExternal: async () => undefined
    })
  }
}

describe('DesktopControlService', () => {
  it('keeps Linux unsupported and never calls capturer or native helper', async () => {
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
    await expect(
      new ComputerUseService(api).execute({ action: 'observe', mode: 'semantic' }, scope)
    ).rejects.toThrow(/macOS/)
    expect(getSources).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
  })

  it('returns AX dump without probing screen capture or sending screenshot bytes', async () => {
    const { api, getSources } = service({ status: 'denied' })
    const result = await api.dispatch({ type: 'accessibility-dump' })
    expect(result).toMatchObject({ type: 'accessibility-dump', dump: { app: 'Finder' } })
    expect(JSON.stringify(result)).not.toContain('data:image')
    expect(getSources).not.toHaveBeenCalled()
    const hit = await api.dispatch({ type: 'input-preview', x: 12, y: 12 })
    expect(hit).toMatchObject({
      type: 'input-preview',
      target: { role: 'button', title: 'OK' }
    })
  })

  it('refuses settings input on a locked session even when TCC looks granted', async () => {
    const { api, exec } = service({ locked: true })
    expect(
      await api.dispatch({ type: 'input-click', x: 12, y: 12, confirmed: true })
    ).toMatchObject({ executed: false })
    expect(
      exec.mock.calls.some((call) => {
        const command = JSON.parse(String(call[1]?.[0] ?? '{}'))
        return command.action === 'click'
      })
    ).toBe(false)
  })

  it('dispatches a confirmed settings click using accessibility without capture probing', async () => {
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

  it('rejects a cancelled agent operation before touching native automation', async () => {
    const { api, exec, getSources } = service({})
    const controller = new AbortController()
    controller.abort()

    await expect(
      new ComputerUseService(api).execute(
        { action: 'observe', mode: 'semantic' },
        scope,
        controller.signal
      )
    ).rejects.toThrow()
    expect(exec).not.toHaveBeenCalled()
    expect(getSources).not.toHaveBeenCalled()
  })

  it('types after the same hard gates as click', async () => {
    const { api } = service({})
    const computer = new ComputerUseService(api)
    const observation = await computer.execute({ action: 'observe', mode: 'semantic' }, scope)
    if (observation.kind !== 'observation') throw new Error('expected observation')
    await expect(
      computer.execute(
        {
          action: 'act',
          stateId: observation.stateId,
          target: { kind: 'ref', ref: '@e2' },
          intent: 'type',
          text: 'hello'
        },
        scope
      )
    ).resolves.toMatchObject({ kind: 'action', action: 'type' })
  })
})
