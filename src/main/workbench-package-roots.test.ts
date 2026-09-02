import { describe, expect, it, vi } from 'vitest'
import type { PiPackageRoot } from '../shared/workbench-host-contracts'
import {
  createPiPackageRootsLifecycle,
  routePiPackageRootsMessage
} from './workbench-package-roots'

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

describe('Pi package-roots lifecycle', () => {
  it('restores cached roots to a replacement window only for the same identity', () => {
    const lifecycle = createPiPackageRootsLifecycle({
      initialIdentity: { sessionId: 'session-current', generation: 7 },
      warn: vi.fn()
    })
    lifecycle.hostStarted()

    expect(
      lifecycle.handleMessage({
        type: 'desktop-plugin-roots',
        sessionId: 'session-current',
        generation: 7,
        roots: [validRoot]
      })
    ).toBe(true)

    const firstHost = { setPackageRoots: vi.fn(() => Promise.resolve()) }
    lifecycle.attachHost(firstHost)
    expect(firstHost.setPackageRoots).toHaveBeenCalledWith([validRoot])
    lifecycle.detachHost(firstHost)

    const sameIdentityHost = { setPackageRoots: vi.fn(() => Promise.resolve()) }
    lifecycle.attachHost(sameIdentityHost)
    expect(sameIdentityHost.setPackageRoots).toHaveBeenCalledWith([validRoot])
    lifecycle.detachHost(sameIdentityHost)

    lifecycle.transitionIdentity({ sessionId: 'session-next', generation: 8 }, () => undefined)
    const replacementHost = { setPackageRoots: vi.fn(() => Promise.resolve()) }
    lifecycle.attachHost(replacementHost)
    expect(replacementHost.setPackageRoots).not.toHaveBeenCalled()

    expect(
      lifecycle.handleMessage({
        type: 'desktop-plugin-roots',
        sessionId: 'session-current',
        generation: 7,
        roots: [validRoot]
      })
    ).toBe(true)
    expect(replacementHost.setPackageRoots).not.toHaveBeenCalled()
  })

  it('clears views/cache on Agent exit and ignores late roots or duplicate exit signals', () => {
    const warn = vi.fn()
    const lifecycle = createPiPackageRootsLifecycle({
      initialIdentity: { sessionId: 'session-current', generation: 7 },
      warn
    })
    lifecycle.hostStarted()
    const calls: PiPackageRoot[][] = []
    const host = {
      setPackageRoots: vi.fn((roots: readonly PiPackageRoot[]) => {
        calls.push(roots.map((root) => ({ ...root })))
        return Promise.resolve()
      })
    }
    lifecycle.attachHost(host)
    lifecycle.handleMessage({
      type: 'desktop-plugin-roots',
      sessionId: 'session-current',
      generation: 7,
      roots: [validRoot]
    })

    lifecycle.hostExited()
    expect(calls).toEqual([[validRoot], []])
    lifecycle.hostExited()
    expect(calls).toEqual([[validRoot], []])

    lifecycle.handleMessage({
      type: 'desktop-plugin-roots',
      sessionId: 'session-current',
      generation: 7,
      roots: [validRoot]
    })
    expect(calls).toEqual([[validRoot], []])
    lifecycle.detachHost(host)
    const replacementHost = { setPackageRoots: vi.fn(() => Promise.resolve()) }
    lifecycle.attachHost(replacementHost)
    expect(replacementHost.setPackageRoots).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('忽略过期的 Pi package roots 消息')
  })
})
