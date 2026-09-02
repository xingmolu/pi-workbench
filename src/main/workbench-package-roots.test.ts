import { describe, expect, it, vi } from 'vitest'
import { routePiPackageRootsMessage } from './workbench-package-roots'

const validRoot = {
  path: '/Users/example/.pi/agent/packages/example',
  source: 'package-discovery',
  scope: 'user' as const,
  hasExecutablePiResources: true
}

describe('routePiPackageRootsMessage', () => {
  it('replaces roots, including an empty collection, only for the exact active identity', () => {
    const setPackageRoots = vi.fn(() => Promise.resolve())
    const warn = vi.fn()
    const dependencies = {
      readActiveIdentity: () => ({ sessionId: 'session-current', generation: 7 }),
      setPackageRoots,
      warn
    }

    expect(
      routePiPackageRootsMessage(
        {
          type: 'desktop-plugin-roots',
          sessionId: 'session-current',
          generation: 7,
          roots: [validRoot]
        },
        dependencies
      )
    ).toBe(true)
    expect(
      routePiPackageRootsMessage(
        {
          type: 'desktop-plugin-roots',
          sessionId: 'session-current',
          generation: 7,
          roots: []
        },
        dependencies
      )
    ).toBe(true)

    expect(setPackageRoots).toHaveBeenNthCalledWith(1, [validRoot])
    expect(setPackageRoots).toHaveBeenNthCalledWith(2, [])
    expect(warn).not.toHaveBeenCalled()
  })

  it('consumes but rejects stale identities and malformed package-root messages', () => {
    const setPackageRoots = vi.fn(() => Promise.resolve())
    const warn = vi.fn()
    const dependencies = {
      readActiveIdentity: () => ({ sessionId: 'session-current', generation: 7 }),
      setPackageRoots,
      warn
    }

    for (const message of [
      {
        type: 'desktop-plugin-roots',
        sessionId: 'session-old',
        generation: 6,
        roots: [validRoot]
      },
      {
        type: 'desktop-plugin-roots',
        sessionId: 'session-current',
        generation: 7,
        roots: [{ ...validRoot, path: '../relative' }]
      },
      {
        type: 'desktop-plugin-roots',
        sessionId: 'session-current',
        generation: 7,
        roots: [],
        extra: true
      }
    ]) {
      expect(routePiPackageRootsMessage(message, dependencies)).toBe(true)
    }

    expect(setPackageRoots).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it('leaves unrelated host messages for the existing brokers', () => {
    const setPackageRoots = vi.fn(() => Promise.resolve())
    const warn = vi.fn()

    expect(
      routePiPackageRootsMessage(
        { type: 'event', event: 'snapshot', data: {} },
        {
          readActiveIdentity: () => ({ sessionId: null, generation: 0 }),
          setPackageRoots,
          warn
        }
      )
    ).toBe(false)
    expect(setPackageRoots).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('contains synchronous and asynchronous Workbench replacement failures', async () => {
    const warn = vi.fn()
    const message = {
      type: 'desktop-plugin-roots',
      sessionId: 'session-current',
      generation: 7,
      roots: []
    }
    const dependencies = {
      readActiveIdentity: () => ({ sessionId: 'session-current', generation: 7 }),
      warn
    }

    expect(
      routePiPackageRootsMessage(message, {
        ...dependencies,
        setPackageRoots: () => {
          throw new Error('disposed')
        }
      })
    ).toBe(true)
    expect(
      routePiPackageRootsMessage(message, {
        ...dependencies,
        setPackageRoots: () => Promise.reject(new Error('discovery failed'))
      })
    ).toBe(true)

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2))
  })
})
