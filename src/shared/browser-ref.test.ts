import { describe, expect, it } from 'vitest'
import * as browserRef from './browser-ref'

describe('opaque browser reference format', () => {
  it('accepts only canonical UUID snapshot tokens with bounded positive slots', () => {
    const schema = browserRef.browserRefSchema
    expect(schema, 'shared fixed browser reference validator').toBeDefined()
    for (const slot of [1, 9, 10, 99, 100, 160])
      expect(schema.safeParse(`a346309f-07bc-4c76-8046-ea0a938dcd97:${slot}`).success).toBe(true)
    for (const value of [
      '@e1',
      '#one',
      'a'.repeat(10000),
      '------------------------------------:1',
      'a346309f-07bc-4c76-8046-ea0a938dcd97:0',
      'a346309f-07bc-4c76-8046-ea0a938dcd97:161',
      'a346309f-07bc-4c76-8046-ea0a938dcd97:01'
    ])
      expect(schema.safeParse(value).success).toBe(false)
  })
})
