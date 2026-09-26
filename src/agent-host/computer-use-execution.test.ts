import { describe, expect, it, vi } from 'vitest'
import { executeComputerUse, ComputerUseRecoveryFence } from './computer-use-execution'
import type { ComputerUseObservation, ComputerUseResult } from '../shared/computer-use'

const observation: ComputerUseObservation = {
  kind: 'observation',
  stateId: 'state',
  mode: 'semantic',
  app: 'Electron fixture',
  bundleId: 'fixture',
  truncated: false,
  elements: []
}
const visual = {
  scope: 'window' as const,
  sourceId: 'window:7:0',
  displayId: '1',
  framePoints: { x: 0, y: 0, width: 100, height: 100 },
  scaleFactor: 1,
  capturedAt: 1,
  image: { mimeType: 'image/png' as const, data: 'AAAA', width: 100, height: 100 }
}

describe('Computer Use model boundary', () => {
  it('downgrades default/fused observation to semantic for text-only or unknown models', async () => {
    for (const input of [undefined, ['text']]) {
      const call = vi.fn(async (): Promise<ComputerUseResult> => observation)
      const result = await executeComputerUse({ action: 'observe' }, input, call)
      expect(call).toHaveBeenCalledWith({ action: 'observe', mode: 'semantic' }, undefined)
      expect(result.content).toHaveLength(1)
      expect(JSON.stringify(result.content)).toContain('MODEL_IMAGE_INPUT_UNAVAILABLE')
      expect(JSON.stringify(result.content)).toContain('SEMANTIC_CONTENT_LIMITED')
    }
  })
  it('rejects visual observation and screenshot points before host execution for text models', async () => {
    const call = vi.fn(async (): Promise<ComputerUseResult> => observation)
    await expect(
      executeComputerUse({ action: 'observe', mode: 'visual' }, ['text'], call)
    ).rejects.toThrow('MODEL_IMAGE_INPUT_UNAVAILABLE')
    await expect(
      executeComputerUse(
        { action: 'act', stateId: 's', target: { kind: 'point', x: 1, y: 1 }, intent: 'press' },
        ['text'],
        call
      )
    ).rejects.toThrow('MODEL_IMAGE_INPUT_UNAVAILABLE')
    expect(call).not.toHaveBeenCalled()
  })
  it('never serializes image data when a text model acts on an older visual state', async () => {
    const full = { ...observation, mode: 'fused' as const, visual }
    const call = vi.fn(async (): Promise<ComputerUseResult> => ({
      kind: 'action',
      action: 'press',
      previousStateId: 'old',
      target: { kind: 'ref', ref: '@e1' },
      message: 'fixture',
      delivered: true,
      changed: true,
      verification: 'semantic-change',
      observation: full
    }))
    const result = await executeComputerUse(
      { action: 'act', stateId: 'old', target: { kind: 'ref', ref: '@e1' }, intent: 'press' },
      ['text'],
      call
    )
    expect(result.content.every((item) => item.type === 'text')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('AAAA')
  })
  it('keeps vision for image-capable models and warns about bounded observations', async () => {
    const call = vi.fn(async (): Promise<ComputerUseResult> => ({
      ...observation,
      mode: 'fused',
      visual,
      truncated: true
    }))
    const result = await executeComputerUse({ action: 'observe' }, ['text', 'image'], call)
    expect(call).toHaveBeenCalledWith({ action: 'observe' }, undefined)
    expect(result.content.some((item) => item.type === 'image')).toBe(true)
    expect(JSON.stringify(result.content[0])).not.toContain('AAAA')
    expect(JSON.stringify(result.content[0])).toContain('SEMANTIC_TRUNCATED')
  })
})

describe('Computer Use recovery fence', () => {
  it('blocks unrelated tools after unreadable observation until a new user turn or successful observation', async () => {
    const fence = new ComputerUseRecoveryFence()
    await executeComputerUse(
      { action: 'observe' },
      ['text'],
      async () => observation,
      undefined,
      (reason) => fence.update(reason)
    )
    for (const name of ['bash', 'read', 'browser', 'write', 'custom_debugger'])
      expect(fence.check(name, {})).toMatchObject({ block: true })
    expect(fence.check('computer', { action: 'act' })).toMatchObject({ block: true })
    expect(fence.check('computer', { action: 'observe' })).toBeUndefined()
    fence.update(null)
    expect(fence.check('bash', {})).toBeUndefined()
    fence.update('unavailable')
    fence.reset()
    expect(fence.check('read', {})).toBeUndefined()
  })
})
