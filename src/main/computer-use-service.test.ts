import { describe, expect, it, vi } from 'vitest'
import { ComputerUseService } from './computer-use-service'
import { DesktopControlService } from './desktop-control-service'
import type { DesktopCapturerSourceInput } from './desktop-control-capture'

function harness(options: { visual?: boolean } = {}) {
  let buttonTitle = 'OK'
  const visualSource = (): DesktopCapturerSourceInput => ({
    id: 'screen:7:0',
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
    if (command.action === 'session-lock') {
      return { stdout: JSON.stringify({ ok: true, locked: false }) }
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
        windows: [
          {
            role: 'window',
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
          }
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
    isTrustedAccessibilityClient: () => true,
    nativeHelperPath: '/test/pi-computer-use-helper',
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
    exec,
    getSources,
    changeTitle(value: string) {
      buttonTitle = value
    }
  }
}

describe('ComputerUseService', () => {
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

  it('returns fused refs plus a display-aware screenshot when both paths are available', async () => {
    const { api } = harness({ visual: true })
    const observation = await api.execute({ action: 'observe', mode: 'fused' })
    expect(observation).toMatchObject({
      kind: 'observation',
      mode: 'fused',
      app: 'Finder',
      elements: [{ ref: '@e1' }, { ref: '@e2' }],
      visual: {
        displayId: '7',
        framePoints: { x: 100, y: 50, width: 400, height: 200 },
        scaleFactor: 2,
        image: { mimeType: 'image/png', width: 200, height: 100 }
      }
    })
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
        elements: [
          { ref: '@e1' },
          { ref: '@e2', title: 'Done' }
        ]
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
      service.execute(
        { action: 'inspect', stateId: observation.stateId, ref: '@e2' },
        secondScope
      )
    ).rejects.toThrow(/状态已过期/)
  })
})
