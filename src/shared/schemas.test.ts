import { describe, expect, it } from 'vitest'
import {
  browserCommandSchema,
  browserEventSchema,
  hostCommandSchema,
  hostRequestSchema
} from './schemas'
import { BUILTIN_BROWSER_VIEW_ID } from './workbench-contracts'
import { workbenchEventSchema } from './workbench-schemas'

describe('queue:clear schema', () => {
  it('accepts the typed command and request', () => {
    expect(hostCommandSchema.parse({ type: 'queue:clear' })).toEqual({ type: 'queue:clear' })
    expect(hostRequestSchema.parse({ type: 'queue:clear', requestId: 'request-1' })).toEqual({
      type: 'queue:clear',
      requestId: 'request-1'
    })
  })

  it('rejects untyped queue payloads', () => {
    expect(hostCommandSchema.safeParse({ type: 'queue:clear', index: 0 }).success).toBe(false)
  })
})

describe('browser and Workbench event ownership', () => {
  it('keeps Browser events state-only and routes reveal through Workbench', () => {
    expect(browserEventSchema.safeParse({ type: 'agent-open' }).success).toBe(false)
    expect(
      workbenchEventSchema.parse({
        type: 'reveal',
        viewId: BUILTIN_BROWSER_VIEW_ID
      })
    ).toEqual({ type: 'reveal', viewId: BUILTIN_BROWSER_VIEW_ID })
  })

  it('keeps native view placement on the Workbench command surface', () => {
    expect(
      browserCommandSchema.safeParse({
        type: 'view:set',
        visible: true,
        bounds: { x: 0, y: 0, width: 320, height: 480 }
      }).success
    ).toBe(false)
  })
})
