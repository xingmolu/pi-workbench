import { describe, expect, it, vi } from 'vitest'
import { ComputerUseService } from './computer-use-service'
import { DesktopControlService } from './desktop-control-service'
import type { DesktopCapturerSourceInput } from './desktop-control-capture'

function harness(options: { visual?: boolean; extraWindow?: boolean } = {}) {
  let buttonTitle = 'OK'
  let targetWindowId = 77
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
  const getSources = vi.fn(async () => (options.visual ? [visualSource()] : []))
  const exec = vi.fn(async (_file: string, args: readonly string[]) => {
    const command = JSON.parse(String(args[0] ?? '{}')) as Record<string, unknown>
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
            value: '',
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

  const service = new ComputerUseService(desktop)
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
