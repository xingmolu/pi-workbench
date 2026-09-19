import { describe, expect, it } from 'vitest'
import {
  computerUseImagePointToScreenPoint,
  computerUseObservationSchema,
  type ComputerUseVisualFrame
} from './computer-use'

const visual: ComputerUseVisualFrame = {
  displayId: 'external',
  framePoints: { x: -1920, y: 100, width: 1920, height: 1080 },
  scaleFactor: 2,
  capturedAt: 1,
  image: {
    mimeType: 'image/png',
    data: 'aW1hZ2U=',
    width: 1600,
    height: 900
  }
}

describe('computer-use visual contract', () => {
  it('maps screenshot pixels into global DIP coordinates including negative display origins', () => {
    expect(
      computerUseImagePointToScreenPoint(visual, { kind: 'point', x: 800, y: 450 })
    ).toEqual({ x: -960, y: 640 })
  })

  it('rejects points outside the state-bound image', () => {
    expect(() =>
      computerUseImagePointToScreenPoint(visual, { kind: 'point', x: 1600, y: 10 })
    ).toThrow(/截图范围/)
  })

  it('requires image data for visual and fused observations', () => {
    expect(
      computerUseObservationSchema.safeParse({
        kind: 'observation',
        stateId: 'state',
        mode: 'visual',
        app: '',
        bundleId: '',
        truncated: false,
        elements: []
      }).success
    ).toBe(false)
    expect(
      computerUseObservationSchema.safeParse({
        kind: 'observation',
        stateId: 'state',
        mode: 'semantic',
        app: 'Finder',
        bundleId: 'com.apple.finder',
        truncated: false,
        elements: [],
        visual
      }).success
    ).toBe(false)
  })
})
