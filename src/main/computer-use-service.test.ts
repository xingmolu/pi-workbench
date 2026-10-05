import { describe, expect, it, vi } from 'vitest'
import { ComputerUseService } from './computer-use-service'
import { DesktopControlService } from './desktop-control-service'
import type { DesktopCapturerSourceInput } from './desktop-control-capture'

function harness(
  options: {
    visual?: boolean
    extraWindow?: boolean
    selfPid?: number
    /** Finder is not running until `open` starts it. */
    launchable?: boolean
    /** Chromium's window list leaves the target window out. */
    untitledWindow?: boolean
  } = {}
) {
  let buttonTitle = 'OK'
  let windowValue = ''
  let targetWindowId = 77
  let front: 'target' | 'pi' = 'target'
  let running = !options.launchable
  const piTarget = {
    pid: 4242,
    windowId: 5,
    app: 'Pi Desktop',
    bundleId: 'works.pi.desktop',
    frame: { x: 0, y: 0, width: 300, height: 300 }
  }
  const target = () => ({
    pid: 42,
    windowId: targetWindowId,
    app: 'Finder',
    bundleId: 'com.apple.finder',
    frame: { x: 100, y: 50, width: 400, height: 200 }
  })
  const visualSource = (): DesktopCapturerSourceInput => ({
    id: 'window:77:0',
    name: 'External Display',
    display_id: '7',
    thumbnail: {
      isEmpty: () => false,
      getSize: () => ({ width: 200, height: 100 }),
      toDataURL: () => 'data:image/png;base64,aW1hZ2U=',
      toPNG: () => Buffer.from(`image-${buttonTitle}`)
    }
  })
  const screenSource = (): DesktopCapturerSourceInput => {
    const cropped = vi.fn((rect: { x: number; y: number; width: number; height: number }) => ({
      isEmpty: () => false,
      getSize: () => ({ width: rect.width, height: rect.height }),
      toDataURL: () => 'data:image/png;base64,aW1hZ2U=',
      toPNG: () => Buffer.from(`crop-${rect.x}-${rect.y}-${rect.width}-${rect.height}`)
    }))
    return {
      id: 'screen:7:0',
      name: 'Screen',
      display_id: '7',
      thumbnail: {
        isEmpty: () => false,
        getSize: () => ({ width: 800, height: 400 }),
        toDataURL: () => 'data:image/png;base64,aW1hZ2U=',
        crop: cropped
      }
    }
  }
  const getSources = vi.fn(async (request: { types: Array<'screen' | 'window'> }) => {
    if (!options.visual) return []
    if (request.types.includes('screen')) return [screenSource()]
    return options.untitledWindow ? [{ ...visualSource(), id: 'window:12:0' }] : [visualSource()]
  })
  const exec = vi.fn(async (file: string, args: readonly string[]) => {
    if (file === '/usr/bin/open') {
      running = true
      return { stdout: '' }
    }
    const command = JSON.parse(String(args[0] ?? '{}')) as Record<string, unknown>
    if (command.action === 'activate-target') {
      front = 'target'
      return { stdout: JSON.stringify({ ok: true, front: true }) }
    }
    if (command.action === 'activate-app') {
      if (!running) return { stdout: JSON.stringify({ ok: false, error: 'app-not-running' }) }
      front = 'target'
      return {
        stdout: JSON.stringify({
          ok: true,
          front: true,
          app: 'Finder',
          bundleId: 'com.apple.finder'
        })
      }
    }
    if (['key', 'scroll', 'drag', 'paste'].includes(String(command.action))) {
      return { stdout: JSON.stringify({ ok: true }) }
    }
    if (command.action === 'set-value') {
      if (command.value === 'locked')
        return { stdout: JSON.stringify({ ok: false, error: 'not-settable' }) }
      windowValue = String(command.value)
      return { stdout: JSON.stringify({ ok: true }) }
    }
    if (command.action === 'ax-action') {
      if (command.name !== 'menu')
        return {
          stdout: JSON.stringify({ ok: false, error: 'action-unsupported', available: ['AXPress'] })
        }
      return { stdout: JSON.stringify({ ok: true }) }
    }
    if (command.action === 'list-apps') {
      return {
        stdout: JSON.stringify({
          ok: true,
          apps: [
            {
              pid: 42,
              name: 'Finder',
              bundleId: 'com.apple.finder',
              active: true,
              hidden: false,
              windows: 2
            },
            {
              pid: 4242,
              name: 'Pi Desktop',
              bundleId: 'works.pi.desktop',
              active: false,
              hidden: false,
              windows: 1
            }
          ]
        })
      }
    }
    if (command.action === 'list-windows') {
      if (command.app === 'Pi Desktop')
        return {
          stdout: JSON.stringify({
            ok: true,
            pid: 4242,
            app: 'Pi Desktop',
            bundleId: 'works.pi.desktop',
            windows: []
          })
        }
      if (command.app === 'Nope')
        return { stdout: JSON.stringify({ ok: false, error: 'app-not-running' }) }
      return {
        stdout: JSON.stringify({
          ok: true,
          pid: 42,
          app: 'Finder',
          bundleId: 'com.apple.finder',
          windows: [
            {
              title: 'Desktop',
              focused: true,
              minimized: false,
              frame: { x: 100, y: 50, width: 400, height: 200 }
            },
            { title: 'Downloads', focused: false, minimized: true }
          ]
        })
      }
    }
    if (command.action === 'activate-window') {
      if (command.window === 'Nothing')
        return { stdout: JSON.stringify({ ok: false, error: 'window-not-found' }) }
      if (command.window === 'D')
        return {
          stdout: JSON.stringify({
            ok: false,
            error: 'window-ambiguous',
            candidates: ['Desktop', 'Downloads']
          })
        }
      front = 'target'
      return {
        stdout: JSON.stringify({
          ok: true,
          front: true,
          pid: 42,
          app: 'Finder',
          bundleId: 'com.apple.finder'
        })
      }
    }
    if (
      front === 'pi' &&
      (command.action === 'foreground-window' || command.action === 'ax-dump')
    ) {
      return {
        stdout: JSON.stringify(
          command.action === 'foreground-window'
            ? { ok: true, target: piTarget }
            : {
                ok: true,
                app: 'Pi Desktop',
                bundleId: 'works.pi.desktop',
                target: piTarget,
                windows: [
                  {
                    role: 'window',
                    windowId: 5,
                    title: 'Pi Desktop',
                    value: '',
                    description: '',
                    x: 0,
                    y: 0,
                    width: 300,
                    height: 300,
                    children: []
                  }
                ],
                nodeCount: 1,
                truncated: false
              }
        )
      }
    }
    if (command.action === 'accessibility-permission') {
      return { stdout: JSON.stringify({ ok: true, trusted: true }) }
    }
    if (command.action === 'session-lock') {
      return { stdout: JSON.stringify({ ok: true, locked: false }) }
    }
    if (command.action === 'foreground-window') {
      return { stdout: JSON.stringify({ ok: true, target: target() }) }
    }
    if (command.action === 'click') {
      buttonTitle = 'Done'
      return { stdout: JSON.stringify({ ok: true, x: command.x, y: command.y }) }
    }
    if (command.action === 'move') {
      return { stdout: JSON.stringify({ ok: true, x: command.x, y: command.y }) }
    }
    if (command.action === 'type') {
      return { stdout: JSON.stringify({ ok: true }) }
    }
    return {
      stdout: JSON.stringify({
        ok: true,
        app: 'Finder',
        bundleId: 'com.apple.finder',
        target: target(),
        windows: [
          {
            role: 'window',
            windowId: 77,
            title: 'Desktop',
            value: windowValue,
            description: '',
            x: 100,
            y: 50,
            width: 400,
            height: 200,
            children: [
              {
                role: 'button',
                title: buttonTitle,
                value: '',
                description: 'confirmation',
                x: 110,
                y: 60,
                width: 40,
                height: 20,
                children: []
              }
            ]
          },
          ...(options.extraWindow
            ? [
                {
                  role: 'window',
                  windowId: 78,
                  title: 'Other window',
                  value: '',
                  description: '',
                  x: 600,
                  y: 50,
                  width: 400,
                  height: 200,
                  children: [
                    {
                      role: 'button',
                      title: 'Wrong window',
                      value: '',
                      description: '',
                      x: 610,
                      y: 60,
                      width: 40,
                      height: 20,
                      children: []
                    }
                  ]
                }
              ]
            : [])
        ],
        nodeCount: 2,
        truncated: false
      })
    }
  })

  const desktop = new DesktopControlService({
    platform: 'darwin',
    getMediaAccessStatus: () => (options.visual ? 'granted' : 'denied'),
    getSources,
    getDisplays: () =>
      options.visual
        ? [
            {
              id: '7',
              bounds: { x: 100, y: 50, width: 400, height: 200 },
              scaleFactor: 2,
              primary: true
            }
          ]
        : [],
    nativeHelperPath: '/test/pi-computer-use-helper',
    appBundlePath: '/test/Pi Desktop.app',
    nativeExec: exec,
    openExternal: async () => undefined
  })

  const service = new ComputerUseService(
    desktop,
    options.selfPid ? { selfPid: options.selfPid } : {}
  )
  const scope = { ownerId: 'test-runtime', sessionId: 'session-a', generation: 1 }
  return {
    api: {
      execute(operation: unknown, signal?: AbortSignal) {
        return service.execute(operation, scope, signal)
      }
    },
    service,
    desktop,
    exec,
    getSources,
    changeTitle(value: string) {
      buttonTitle = value
    },
    changeTarget(windowId: number) {
      targetWindowId = windowId
    },
    changeElsewhere(value: string) {
      windowValue = value
    },
    /** What approving an action in Pi Desktop does to the foreground. */
    focusPi() {
      front = 'pi'
    }
  }
}

describe('ComputerUseService', () => {
  it('reports a missing native helper instead of claiming the desktop is locked', async () => {
    const { api, exec, service } = harness()
    exec.mockRejectedValue(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    await expect(api.execute({ action: 'observe', mode: 'semantic' })).rejects.toThrow(
      '原生助手缺失'
    )
    expect(service.stateCount).toBe(0)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('reports a failed lock probe without manufacturing a locked desktop', async () => {
    const { api, exec } = harness()
    exec.mockResolvedValueOnce({ stdout: JSON.stringify({ ok: true, trusted: true }) })
    exec.mockRejectedValueOnce(Object.assign(new Error('timeout'), { killed: true }))
    await expect(api.execute({ action: 'observe', mode: 'semantic' })).rejects.toThrow(
      '原生助手调用超时'
    )
  })

  it('creates immutable semantic state with stable refs and searchable elements', async () => {
    const { api, getSources } = harness()
    const observation = await api.execute({ action: 'observe', mode: 'semantic' })
    expect(observation).toMatchObject({
      kind: 'observation',
      mode: 'semantic',
      app: 'Finder'
    })
    if (observation.kind !== 'observation') throw new Error('expected observation')
    expect(observation.elements.map((element) => element.ref)).toEqual(['@e1', '@e2'])

    const search = await api.execute({
      action: 'search',
      stateId: observation.stateId,
      query: 'confirmation'
    })
    expect(search).toMatchObject({
      kind: 'search',
      matches: [{ ref: '@e2', title: 'OK' }]
    })

    const inspect = await api.execute({
      action: 'inspect',
      stateId: observation.stateId,
      ref: '@e2'
    })
    expect(inspect).toMatchObject({
      kind: 'inspect',
      element: { ref: '@e2', role: 'button', title: 'OK' }
    })
    expect(getSources).not.toHaveBeenCalled()
  })

  it('defaults to fused and gracefully falls back to semantic when visual capture is unavailable', async () => {
    const { api } = harness()
    const observation = await api.execute({ action: 'observe' })
    expect(observation).toMatchObject({
      kind: 'observation',
      mode: 'semantic',
      elements: [{ ref: '@e1' }, { ref: '@e2' }]
    })
  })

  it('returns fused refs plus a window screenshot when both paths are available', async () => {
    const { api } = harness({ visual: true })
    const observation = await api.execute({ action: 'observe', mode: 'fused' })
    expect(observation).toMatchObject({
      kind: 'observation',
      mode: 'fused',
      app: 'Finder',
      elements: [{ ref: '@e1' }, { ref: '@e2' }],
      visual: {
        scope: 'window',
        sourceId: 'window:77:0',
        displayId: '7',
        framePoints: { x: 100, y: 50, width: 400, height: 200 },
        scaleFactor: 2,
        image: { mimeType: 'image/png', width: 200, height: 100 }
      }
    })
  })

  it('excludes refs belonging to another window of the same application', async () => {
    const { api } = harness({ visual: true, extraWindow: true })
    const observation = await api.execute({ action: 'observe', mode: 'fused' })
    if (observation.kind !== 'observation') throw new Error('expected observation')
    expect(observation.elements.map((element) => element.title)).toEqual(['Desktop', 'OK'])
  })

  it('rejects a semantic tree whose window ID does not match the focused target', async () => {
    const h = harness()
    h.changeTarget(78)
    await expect(h.api.execute({ action: 'observe', mode: 'semantic' })).rejects.toThrow(
      '辅助功能窗口身份不一致'
    )
    expect(h.service.stateCount).toBe(0)
  })

  it('scopes semantic-only refs to the focused window before protected input', async () => {
    const h = harness({ extraWindow: true })
    const observation = await h.api.execute({ action: 'observe', mode: 'semantic' })
    if (observation.kind !== 'observation') throw new Error('expected observation')
    expect(observation.elements.map((element) => element.title)).toEqual(['Desktop', 'OK'])
    await expect(
      h.api.execute({
        action: 'act',
        stateId: observation.stateId,
        target: { kind: 'ref', ref: '@e2' },
        intent: 'press'
      })
    ).resolves.toMatchObject({
      kind: 'action',
      delivered: true
    })
    const click = h.exec.mock.calls.find(
      (call) => JSON.parse(String(call[1]?.[0] ?? '{}')).action === 'click'
    )
    expect(JSON.parse(String(click?.[1]?.[0] ?? '{}')).expectedTarget).toMatchObject({
      windowId: 77
    })
  })

  it('rejects a foreground window change during capture without creating a fused state', async () => {
    const h = harness({ visual: true })
    h.getSources.mockImplementationOnce(async () => {
      h.changeTarget(78)
      return [
        {
          id: 'window:77:0',
          name: 'old',
          thumbnail: {
            getSize: () => ({ width: 200, height: 100 }),
            toDataURL: () => 'data:image/png;base64,aW1hZ2U='
          }
        }
      ]
    })
    await expect(h.api.execute({ action: 'observe', mode: 'fused' })).rejects.toThrow(/窗口已变化/)
    expect(h.service.stateCount).toBe(0)
  })

  it('rejects a window switch after AX reading before requesting screenshots', async () => {
    const h = harness({ visual: true })
    const original = h.exec.getMockImplementation()!
    h.exec.mockImplementation(async (file, args) => {
      const command = JSON.parse(String(args[0] ?? '{}')) as Record<string, unknown>
      const result = await original(file, args)
      if (command.action === 'ax-dump') h.changeTarget(78)
      return result
    })
    await expect(h.api.execute({ action: 'observe', mode: 'fused' })).rejects.toThrow(
      /目标窗口不一致/
    )
    expect(h.getSources).not.toHaveBeenCalled()
    expect(h.service.stateCount).toBe(0)
  })

  it('does not silently downgrade fused mode when the foreground window is ambiguous', async () => {
    const h = harness({ visual: true })
    const original = h.exec.getMockImplementation()!
    h.exec.mockImplementation(async (file, args) => {
      const command = JSON.parse(String(args[0] ?? '{}')) as Record<string, unknown>
      return command.action === 'foreground-window'
        ? { stdout: JSON.stringify({ ok: false, error: 'ambiguous-foreground-window' }) }
        : original(file, args)
    })
    await expect(h.api.execute({ action: 'observe', mode: 'fused' })).rejects.toThrow(/唯一识别/)
    expect(h.getSources).not.toHaveBeenCalled()
    expect(h.service.stateCount).toBe(0)
  })

  it('rejects a stale window before a visual point click', async () => {
    const h = harness({ visual: true })
    const observation = await h.api.execute({ action: 'observe', mode: 'visual' })
    if (observation.kind !== 'observation') throw new Error('expected observation')
    h.changeTarget(78)
    await expect(
      h.api.execute({
        action: 'act',
        stateId: observation.stateId,
        target: { kind: 'point', x: 50, y: 25 },
        intent: 'press'
      })
    ).rejects.toThrow(/窗口已变化/)
    expect(
      h.exec.mock.calls.some((call) => JSON.parse(String(call[1]?.[0] ?? '{}')).action === 'click')
    ).toBe(false)
  })

  it('surfaces native target rejection at the final delivery boundary', async () => {
    const h = harness({ visual: true })
    const observation = await h.api.execute({ action: 'observe', mode: 'visual' })
    if (observation.kind !== 'observation') throw new Error('expected observation')
    const original = h.exec.getMockImplementation()!
    h.exec.mockImplementation(async (file, args) => {
      const command = JSON.parse(String(args[0] ?? '{}')) as Record<string, unknown>
      if (command.action === 'click') {
        expect(command.expectedTarget).toMatchObject({ windowId: 77 })
        throw Object.assign(new Error('native rejected'), {
          stdout: JSON.stringify({ ok: false, error: 'target-changed' })
        })
      }
      return original(file, args)
    })
    await expect(
      h.api.execute({
        action: 'act',
        stateId: observation.stateId,
        target: { kind: 'point', x: 50, y: 25 },
        intent: 'press'
      })
    ).rejects.toThrow(/目标窗口已变化/)
  })

  it('supports visual-only observation and maps screenshot pixels back to global screen points', async () => {
    const { api, exec } = harness({ visual: true })
    const observation = await api.execute({ action: 'observe', mode: 'visual' })
    expect(observation).toMatchObject({
      kind: 'observation',
      mode: 'visual',
      elements: [],
      visual: {
        displayId: '7',
        image: { width: 200, height: 100 }
      }
    })
    if (observation.kind !== 'observation') throw new Error('expected observation')

    const result = await api.execute({
      action: 'act',
      stateId: observation.stateId,
      target: { kind: 'point', x: 50, y: 25 },
      intent: 'press'
    })
    expect(result).toMatchObject({
      kind: 'action',
      target: { kind: 'point', x: 50, y: 25 },
      action: 'press',
      delivered: true,
      changed: true,
      verification: 'visual-change',
      observation: { kind: 'observation', mode: 'visual' }
    })
    expect(
      exec.mock.calls.some((call) => {
        const command = JSON.parse(String(call[1]?.[0] ?? '{}'))
        return command.action === 'click' && command.x === 200 && command.y === 100
      })
    ).toBe(true)
  })

  it('rejects an expired visual point state before delivering input', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const { api, exec } = harness({ visual: true })
      const observation = await api.execute({ action: 'observe', mode: 'visual' })
      if (observation.kind !== 'observation') throw new Error('expected observation')
      clock.mockReturnValue(31_001)

      await expect(
        api.execute({
          action: 'act',
          stateId: observation.stateId,
          target: { kind: 'point', x: 50, y: 25 },
          intent: 'press'
        })
      ).rejects.toThrow(/状态已过期/)

      expect(
        exec.mock.calls.some((call) => {
          const command = JSON.parse(String(call[1]?.[0] ?? '{}'))
          return command.action === 'click'
        })
      ).toBe(false)
    } finally {
      clock.mockRestore()
    }
  })

  it('rechecks visual expiry after the AX input probe', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const h = harness({ visual: true })
      const observation = await h.api.execute({ action: 'observe', mode: 'visual' })
      if (observation.kind !== 'observation') throw new Error('expected observation')
      const original = h.exec.getMockImplementation()!
      h.exec.mockImplementation(async (file, args) => {
        const command = JSON.parse(String(args[0] ?? '{}')) as Record<string, unknown>
        const result = await original(file, args)
        if (command.action === 'ax-dump') clock.mockReturnValue(31_001)
        return result
      })
      await expect(
        h.api.execute({
          action: 'act',
          stateId: observation.stateId,
          target: { kind: 'point', x: 50, y: 25 },
          intent: 'press'
        })
      ).rejects.toThrow(/状态已过期/)
      expect(
        h.exec.mock.calls.some(
          (call) => JSON.parse(String(call[1]?.[0] ?? '{}')).action === 'click'
        )
      ).toBe(false)
    } finally {
      clock.mockRestore()
    }
  })

  it('rejects stale semantic state before delivering ref input', async () => {
    const { api, exec, changeTitle } = harness()
    const observation = await api.execute({ action: 'observe', mode: 'semantic' })
    if (observation.kind !== 'observation') throw new Error('expected observation')
    changeTitle('Changed externally')

    await expect(
      api.execute({
        action: 'act',
        stateId: observation.stateId,
        target: { kind: 'ref', ref: '@e2' },
        intent: 'press'
      })
    ).rejects.toThrow(/状态已变化/)

    expect(
      exec.mock.calls.some((call) => String(call[1]?.[3]).includes('kCGEventLeftMouseDown'))
    ).toBe(false)
  })

  it('returns a successor state after a ref action and reports semantic verification', async () => {
    const { api } = harness()
    const observation = await api.execute({ action: 'observe', mode: 'semantic' })
    if (observation.kind !== 'observation') throw new Error('expected observation')

    const result = await api.execute({
      action: 'act',
      stateId: observation.stateId,
      target: { kind: 'ref', ref: '@e2' },
      intent: 'press'
    })
    expect(result).toMatchObject({
      kind: 'action',
      previousStateId: observation.stateId,
      target: { kind: 'ref', ref: '@e2' },
      action: 'press',
      delivered: true,
      changed: true,
      verification: 'semantic-change',
      observation: {
        kind: 'observation',
        elements: [{ ref: '@e1' }, { ref: '@e2', title: 'Done' }]
      }
    })
    if (result.kind !== 'action') throw new Error('expected action')
    expect(result.observation.stateId).not.toBe(observation.stateId)

    await expect(
      api.execute({ action: 'inspect', stateId: observation.stateId, ref: '@e2' })
    ).rejects.toThrow(/状态已过期/)
  })

  it('raises the observed window again after approving in Pi Desktop took focus', async () => {
    const { api, exec, focusPi } = harness({ selfPid: 4242 })
    const observation = await api.execute({ action: 'observe', mode: 'semantic' })
    if (observation.kind !== 'observation') throw new Error('expected observation')
    focusPi()
    const result = await api.execute({
      action: 'act',
      stateId: observation.stateId,
      target: { kind: 'ref', ref: '@e2' },
      intent: 'press'
    })
    expect(result).toMatchObject({ kind: 'action', delivered: true })
    const actions = exec.mock.calls.map((call) => JSON.parse(String(call[1][0])).action)
    expect(actions.indexOf('activate-target')).toBeGreaterThan(-1)
    expect(actions.indexOf('activate-target')).toBeLessThan(actions.indexOf('click'))
  })

  it('still refuses when raising the window does not bring it back', async () => {
    const { api, exec, focusPi } = harness()
    const observation = await api.execute({ action: 'observe', mode: 'semantic' })
    if (observation.kind !== 'observation') throw new Error('expected observation')
    focusPi()
    exec.mockImplementationOnce(async () => ({
      stdout: JSON.stringify({
        ok: true,
        target: {
          pid: 4242,
          windowId: 5,
          app: 'Pi Desktop',
          bundleId: 'works.pi.desktop',
          frame: { x: 0, y: 0, width: 300, height: 300 }
        }
      })
    }))
    exec.mockImplementationOnce(async () => ({
      stdout: JSON.stringify({ ok: false, error: 'target-missing' })
    }))
    exec.mockImplementation(async (_file: string, args: readonly string[]) => {
      const command = JSON.parse(String(args[0]))
      if (command.action === 'accessibility-permission')
        return { stdout: JSON.stringify({ ok: true, trusted: true }) }
      if (command.action === 'session-lock')
        return { stdout: JSON.stringify({ ok: true, locked: false }) }
      return {
        stdout: JSON.stringify({
          ok: true,
          app: 'Pi Desktop',
          bundleId: 'works.pi.desktop',
          target: {
            pid: 4242,
            windowId: 5,
            app: 'Pi Desktop',
            bundleId: 'works.pi.desktop',
            frame: { x: 0, y: 0, width: 300, height: 300 }
          },
          windows: [],
          nodeCount: 0,
          truncated: false
        })
      }
    })
    await expect(
      api.execute({
        action: 'act',
        stateId: observation.stateId,
        target: { kind: 'ref', ref: '@e2' },
        intent: 'press'
      })
    ).rejects.toThrow(/状态已变化|目标窗口已变化/)
    expect(exec.mock.calls.some((call) => String(call[1][0]).includes('"click"'))).toBe(false)
  })

  it('never observes Pi Desktop itself and points the agent at activate', async () => {
    const { api, focusPi, service } = harness({ selfPid: 4242 })
    focusPi()
    await expect(api.execute({ action: 'observe', mode: 'semantic' })).rejects.toThrow(
      /Pi Desktop 本身[\s\S]*activate/
    )
    expect(service.stateCount).toBe(0)
  })

  it('switches to an app by name and returns its observation', async () => {
    const { api, focusPi } = harness({ selfPid: 4242 })
    focusPi()
    await expect(
      api.execute({ action: 'activate', app: 'Finder', mode: 'semantic' })
    ).resolves.toMatchObject({
      kind: 'observation',
      app: 'Finder',
      elements: [{ ref: '@e1' }, { ref: '@e2', title: 'OK' }]
    })
  })

  it('starts an app that is not running before switching to it', async () => {
    const { api, exec } = harness({ launchable: true })
    await expect(
      api.execute({ action: 'activate', app: 'Finder', mode: 'semantic' })
    ).resolves.toMatchObject({ kind: 'observation', app: 'Finder' })
    expect(exec).toHaveBeenCalledWith('/usr/bin/open', ['-a', 'Finder'], expect.anything())
    await expect(api.execute({ action: 'activate', app: '-n' })).rejects.toThrow('应用名称无效')
  })

  it('presses a key in the observed window only', async () => {
    const { api, exec, changeTarget } = harness()
    const observation = await api.execute({ action: 'observe', mode: 'semantic' })
    if (observation.kind !== 'observation') throw new Error('expected observation')
    await expect(
      api.execute({ action: 'act', stateId: observation.stateId, intent: 'key' })
    ).rejects.toThrow('key 操作需要 key')
    const result = await api.execute({
      action: 'act',
      stateId: observation.stateId,
      intent: 'key',
      key: 'Enter'
    })
    expect(result).toMatchObject({ kind: 'action', action: 'key', delivered: true })
    const key = exec.mock.calls
      .map((call) => JSON.parse(String(call[1][0])))
      .find((command) => command.action === 'key')
    expect(key).toMatchObject({ key: 'Enter', expectedTarget: { windowId: 77 } })
    if (result.kind !== 'action') throw new Error('expected action')
    changeTarget(78)
    await expect(
      api.execute({
        action: 'act',
        stateId: result.observation.stateId,
        intent: 'key',
        key: 'Enter'
      })
    ).rejects.toThrow('目标窗口已变化')
    await expect(
      api.execute({ action: 'act', stateId: observation.stateId, intent: 'press' })
    ).rejects.toThrow('press 操作需要 target')
  })

  it('lets a ref action through when only other content of a live app changed', async () => {
    const { api, exec, changeElsewhere } = harness()
    const observation = await api.execute({ action: 'observe', mode: 'semantic' })
    if (observation.kind !== 'observation') throw new Error('expected observation')
    changeElsewhere('3 new messages')
    await expect(
      api.execute({
        action: 'act',
        stateId: observation.stateId,
        target: { kind: 'ref', ref: '@e2' },
        intent: 'press'
      })
    ).resolves.toMatchObject({ kind: 'action', delivered: true })
    expect(exec.mock.calls.some((call) => String(call[1][0]).includes('"click"'))).toBe(true)
  })

  it('crops the window from its display when the capturer omits the window', async () => {
    const { api } = harness({ visual: true, untitledWindow: true })
    const observation = await api.execute({ action: 'observe', mode: 'fused' })
    expect(observation).toMatchObject({
      kind: 'observation',
      mode: 'fused',
      visual: {
        scope: 'display-crop',
        sourceId: 'screen:7:0',
        framePoints: { x: 100, y: 50, width: 400, height: 200 },
        // The display thumbnail is 800 wide for 400 points: the whole window at 2x.
        image: { width: 800, height: 400 }
      }
    })
  })

  it('does not allow one runtime session to consume another session state', async () => {
    const { service } = harness()
    const firstScope = { ownerId: 'pi:worker-1', sessionId: 'session-a', generation: 1 }
    const secondScope = { ownerId: 'codex:worker-2', sessionId: 'session-b', generation: 1 }
    const observation = await service.execute({ action: 'observe', mode: 'semantic' }, firstScope)
    if (observation.kind !== 'observation') throw new Error('expected observation')

    await expect(
      service.execute({ action: 'inspect', stateId: observation.stateId, ref: '@e2' }, secondScope)
    ).rejects.toThrow(/状态已过期/)
  })
})

describe('Computer Use owner retirement', () => {
  it('releases cached state and rejects a late observe even when the platform ignores abort', async () => {
    const { service, desktop, api } = harness()
    const first = await api.execute({ action: 'observe', mode: 'semantic' })
    expect(service.stateCount).toBe(1)
    const semantic = await desktop.accessibility.dump()
    let complete!: (result: typeof semantic) => void
    vi.spyOn(desktop.accessibility, 'dump').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const late = api.execute({ action: 'observe', mode: 'semantic' })
    const rejected = expect(late).rejects.toThrow()
    service.releaseOwner('test-runtime')
    service.releaseOwner('test-runtime')
    expect(service.stateCount).toBe(0)
    const successor = await api.execute({ action: 'observe', mode: 'semantic' })
    complete(semantic)
    await rejected
    expect(service.stateCount).toBe(1)
    await expect(
      api.execute({
        action: 'search',
        stateId: successor.kind === 'observation' ? successor.stateId : '',
        query: 'OK'
      })
    ).resolves.toMatchObject({ kind: 'search' })
    await expect(
      api.execute({
        action: 'search',
        stateId: first.kind === 'observation' ? first.stateId : '',
        query: 'OK'
      })
    ).rejects.toThrow('过期')
    await api.execute({ action: 'observe', mode: 'semantic' })
    expect(service.stateCount).toBe(1)
  })
})

describe('Computer Use actions', () => {
  const sent = (
    exec: ReturnType<typeof harness>['exec'],
    action: string
  ): Record<string, unknown>[] =>
    exec.mock.calls
      .map((call) => JSON.parse(String(call[1]?.[0] ?? '{}')) as Record<string, unknown>)
      .filter((command) => command.action === action)

  async function observed(h: ReturnType<typeof harness>): Promise<string> {
    const observation = await h.api.execute({ action: 'observe', mode: 'semantic' })
    if (observation.kind !== 'observation') throw new Error('expected observation')
    return observation.stateId
  }

  it('presses shortcuts with modifiers and refuses ones that leave the window', async () => {
    const h = harness()
    const stateId = await observed(h)
    await h.api.execute({ action: 'act', stateId, intent: 'key', key: 'Command+Shift+Z' })
    expect(sent(h.exec, 'key')[0]).toMatchObject({ key: 'z', modifiers: ['cmd', 'shift'] })
    const next = await observed(h)
    for (const key of ['cmd+Tab', 'cmd+q', 'cmd+space', 'ctrl+ArrowRight', 'hyper+x', 'cmd+é'])
      await expect(
        h.api.execute({ action: 'act', stateId: next, intent: 'key', key })
      ).rejects.toThrow()
    expect(sent(h.exec, 'key')).toHaveLength(1)
  })

  it('scrolls at the window centre or at a ref, in wheel lines', async () => {
    const h = harness()
    let stateId = await observed(h)
    await h.api.execute({ action: 'act', stateId, intent: 'scroll', direction: 'down' })
    stateId = await observed(h)
    await h.api.execute({
      action: 'act',
      stateId,
      intent: 'scroll',
      direction: 'left',
      amount: 2,
      target: { kind: 'ref', ref: '@e2' }
    })
    expect(sent(h.exec, 'scroll')).toEqual([
      expect.objectContaining({ x: 300, y: 150, deltaX: 0, deltaY: -9 }),
      expect.objectContaining({ x: 130, y: 70, deltaX: 6, deltaY: 0 })
    ])
    await expect(
      h.api.execute({ action: 'act', stateId: await observed(h), intent: 'scroll' })
    ).rejects.toThrow('scroll 操作需要 direction')
  })

  it('drags between two refs of the observed window', async () => {
    const h = harness()
    const stateId = await observed(h)
    await h.api.execute({
      action: 'act',
      stateId,
      intent: 'drag',
      target: { kind: 'ref', ref: '@e2' },
      to: { kind: 'ref', ref: '@e1' }
    })
    expect(sent(h.exec, 'drag')[0]).toMatchObject({
      x: 130,
      y: 70,
      toX: 300,
      toY: 150,
      expectedTarget: { windowId: 77 }
    })
  })

  it('pastes long text, focusing the target first when given', async () => {
    const h = harness()
    const text = 'x'.repeat(5000)
    await expect(
      h.api.execute({
        action: 'act',
        stateId: await observed(h),
        intent: 'type',
        text,
        target: { kind: 'ref', ref: '@e2' }
      })
    ).rejects.toThrow('paste')
    await h.api.execute({
      action: 'act',
      stateId: await observed(h),
      intent: 'paste',
      text,
      target: { kind: 'ref', ref: '@e2' }
    })
    expect(sent(h.exec, 'click')).toHaveLength(1)
    expect(sent(h.exec, 'paste')[0]).toMatchObject({ text, expectedTarget: { windowId: 77 } })
  })

  it('sets values directly and reports controls that cannot take one', async () => {
    const h = harness()
    const result = await h.api.execute({
      action: 'act',
      stateId: await observed(h),
      intent: 'set_value',
      target: { kind: 'ref', ref: '@e2' },
      value: '42'
    })
    expect(result).toMatchObject({ kind: 'action', action: 'set_value', changed: true })
    expect(sent(h.exec, 'set-value')[0]).toMatchObject({ x: 130, y: 70, value: '42' })
    await expect(
      h.api.execute({
        action: 'act',
        stateId: await observed(h),
        intent: 'set_value',
        target: { kind: 'ref', ref: '@e2' },
        value: 'locked'
      })
    ).rejects.toThrow('不能直接设置')
  })

  it('performs secondary accessibility actions and lists the supported ones otherwise', async () => {
    const h = harness()
    await h.api.execute({
      action: 'act',
      stateId: await observed(h),
      intent: 'secondary',
      name: 'menu',
      target: { kind: 'ref', ref: '@e2' }
    })
    await expect(
      h.api.execute({
        action: 'act',
        stateId: await observed(h),
        intent: 'secondary',
        name: 'increment',
        target: { kind: 'ref', ref: '@e2' }
      })
    ).rejects.toThrow('AXPress')
  })

  // A click renames the button in this harness, so the last step presses the window itself.
  it('runs several steps in one call with a single observation afterwards', async () => {
    const h = harness()
    const stateId = await observed(h)
    const dumps = sent(h.exec, 'ax-dump').length
    const result = await h.api.execute({
      action: 'act',
      stateId,
      steps: [
        { intent: 'type', target: { kind: 'ref', ref: '@e2' }, text: 'hello' },
        { intent: 'key', key: 'Enter' },
        { intent: 'press', target: { kind: 'ref', ref: '@e1' } }
      ]
    })
    expect(result).toMatchObject({ kind: 'action', action: 'press', steps: 3, changed: true })
    expect(sent(h.exec, 'type')).toHaveLength(1)
    expect(sent(h.exec, 'key')).toHaveLength(1)
    expect(sent(h.exec, 'click')).toHaveLength(2)
    // One AX read per ref step plus the closing observation.
    expect(sent(h.exec, 'ax-dump').length - dumps).toBe(3)
  })

  it('validates every step before sending any input and stops at the first failure', async () => {
    const h = harness()
    await expect(
      h.api.execute({
        action: 'act',
        stateId: await observed(h),
        steps: [{ intent: 'key', key: 'Enter' }, { intent: 'press' }]
      })
    ).rejects.toThrow('第 2 步无效')
    expect(sent(h.exec, 'key')).toHaveLength(0)
    await expect(
      h.api.execute({
        action: 'act',
        stateId: await observed(h),
        intent: 'key',
        key: 'Enter',
        steps: [{ intent: 'key', key: 'Tab' }]
      })
    ).rejects.toThrow()
    const stateId = await observed(h)
    await expect(
      h.api.execute({
        action: 'act',
        stateId,
        steps: [
          { intent: 'key', key: 'Enter' },
          { intent: 'press', target: { kind: 'ref', ref: '@e9' } },
          { intent: 'key', key: 'Tab' }
        ]
      })
    ).rejects.toThrow(/第 2 步失败（前 1 步已执行/)
    expect(sent(h.exec, 'key').map((command) => command.key)).toEqual(['Enter'])
    await expect(
      h.api.execute({ action: 'act', stateId, intent: 'key', key: 'Enter' })
    ).rejects.toThrow('状态已过期')
  })

  it('lists running apps and windows without exposing Pi Desktop', async () => {
    const h = harness({ selfPid: 4242 })
    await expect(h.api.execute({ action: 'apps' })).resolves.toEqual({
      kind: 'apps',
      apps: [
        { name: 'Finder', bundleId: 'com.apple.finder', active: true, hidden: false, windows: 2 }
      ]
    })
    await expect(h.api.execute({ action: 'windows', app: 'Finder' })).resolves.toMatchObject({
      kind: 'windows',
      app: 'Finder',
      windows: [
        { title: 'Desktop', focused: true, minimized: false },
        { title: 'Downloads', focused: false, minimized: true }
      ]
    })
    await expect(h.api.execute({ action: 'windows', app: 'Pi Desktop' })).rejects.toThrow(
      'Pi Desktop 本身'
    )
    await expect(h.api.execute({ action: 'windows', app: 'Nope' })).rejects.toThrow('没有找到')
  })

  it('switches to a window by title and observes it', async () => {
    const h = harness()
    await expect(
      h.api.execute({ action: 'activate', app: 'Finder', window: 'Desk', mode: 'semantic' })
    ).resolves.toMatchObject({ kind: 'observation', app: 'Finder' })
    expect(sent(h.exec, 'activate-window')[0]).toMatchObject({ app: 'Finder', window: 'Desk' })
    await expect(
      h.api.execute({ action: 'activate', app: 'Finder', window: 'Nothing' })
    ).rejects.toThrow('没有标题包含')
    await expect(h.api.execute({ action: 'activate', app: 'Finder', window: 'D' })).rejects.toThrow(
      'Desktop、Downloads'
    )
  })
})
