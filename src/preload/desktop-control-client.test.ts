import { describe, expect, it, vi } from 'vitest'
import { createDesktopControlClient } from './desktop-control-client'

describe('desktop control preload client', () => {
  it('validates commands and results before they reach the renderer', async () => {
    const invoke = vi.fn(async () => ({
      type: 'permission',
      permission: {
        platformSupported: false,
        mediaAccessStatus: 'unavailable',
        access: 'unsupported',
        canCapture: false,
        canOpenSettings: false
      }
    }))
    const client = createDesktopControlClient({ invoke })
    await expect(client.desktopControl({ type: 'permission' })).resolves.toMatchObject({
      type: 'permission',
      permission: { access: 'unsupported' }
    })
    expect(invoke).toHaveBeenCalledExactlyOnceWith({ type: 'permission' })
    await expect(client.desktopControl({ type: 'click' } as never)).rejects.toThrow()
    await expect(
      client.desktopControl({ type: 'input-click', x: 1, y: 2 } as never)
    ).rejects.toThrow()
    invoke.mockResolvedValueOnce({ type: 'permission', extra: true } as never)
    await expect(client.desktopControl({ type: 'permission' })).rejects.toThrow()
  })
})
