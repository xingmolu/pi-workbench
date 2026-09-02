import { describe, expect, it } from 'vitest'
import { piPackageRootsMessageSchema } from './workbench-host-schemas'

describe('Pi package-root message schema', () => {
  it('accepts trusted absolute package roots', () => {
    const message = {
      type: 'desktop-plugin-roots',
      sessionId: 'session-1',
      generation: 4,
      roots: [
        {
          path: '/Users/me/.pi/agent/extensions/example',
          source: 'package-discovery',
          scope: 'user',
          hasExecutablePiResources: true
        },
        {
          path: 'C:\\Users\\me\\project\\.pi\\extensions\\example',
          source: 'project-package-discovery',
          scope: 'project',
          hasExecutablePiResources: false
        }
      ]
    } as const

    expect(piPackageRootsMessageSchema.parse(message)).toEqual(message)
  })

  it('rejects malformed or renderer-shaped package-root messages', () => {
    const cases = [
      {
        type: 'desktop-plugin-roots',
        sessionId: null,
        generation: 0,
        roots: [
          {
            path: '../relative/plugin',
            source: 'package-discovery',
            scope: 'user',
            hasExecutablePiResources: false
          }
        ]
      },
      {
        type: 'desktop-plugin-roots',
        sessionId: null,
        generation: -1,
        roots: []
      },
      {
        type: 'desktop-plugin-roots',
        sessionId: null,
        generation: 0,
        roots: [],
        webContents: {}
      }
    ]

    for (const value of cases) {
      expect(piPackageRootsMessageSchema.safeParse(value).success).toBe(false)
    }
  })
})
