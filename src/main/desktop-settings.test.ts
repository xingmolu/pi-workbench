import { describe, expect, it, vi } from 'vitest'
import { handleDesktopSettings } from './desktop-settings'
import {
  DEFAULT_DESKTOP_SETTINGS as defaults,
  desktopSettingsSchema,
  shouldSendOnKey
} from '../shared/desktop-settings'

describe('desktop preferences boundary', () => {
  it.each([
    { messageFontSize: 12 },
    { messageFontSize: 19 },
    { messageFontSize: 14.5 },
    { codeFontSize: 10 },
    { codeFontSize: 17 },
    { codeWrap: 'false' },
    { reducedMotion: 1 },
    { showUsage: null },
    { sendShortcut: 'shift-enter' },
    { workDetails: 'all' },
    { extra: true }
  ])('rejects invalid field %j', (patch) => {
    expect(desktopSettingsSchema.safeParse({ ...defaults, ...patch }).success).toBe(false)
  })
  it('does not overwrite corrupt persisted values on read and resets only its key', () => {
    const store = { get: vi.fn(() => ({ corrupted: true })), set: vi.fn(), delete: vi.fn() }
    expect(handleDesktopSettings(store, { type: 'get' })).toEqual(defaults)
    expect(store.set).not.toHaveBeenCalled()
    handleDesktopSettings(store, { type: 'reset' })
    expect(store.delete).toHaveBeenCalledExactlyOnceWith('desktopSettings')
  })
  it('persists only validated settings and propagates disk failure', () => {
    const store = {
      get: vi.fn(),
      set: vi.fn(() => {
        throw new Error('disk full')
      }),
      delete: vi.fn()
    }
    expect(() =>
      handleDesktopSettings(store, { type: 'save', settings: { ...defaults, extra: 1 } })
    ).toThrow()
    expect(store.set).not.toHaveBeenCalled()
    expect(() => handleDesktopSettings(store, { type: 'save', settings: defaults })).toThrow(
      'disk full'
    )
  })
  it('enforces shortcuts, Shift newline and IME guards', () => {
    const key = {
      key: 'Enter',
      keyCode: 13,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      isComposing: false
    }
    expect(shouldSendOnKey(key, 'enter')).toBe(true)
    expect(shouldSendOnKey(key, 'modifier-enter')).toBe(false)
    expect(shouldSendOnKey({ ...key, ctrlKey: true }, 'modifier-enter')).toBe(true)
    expect(shouldSendOnKey({ ...key, metaKey: true }, 'modifier-enter')).toBe(true)
    for (const patch of [
      { shiftKey: true, ctrlKey: true },
      { isComposing: true },
      { keyCode: 229 },
      { key: 'a' }
    ])
      expect(shouldSendOnKey({ ...key, ...patch }, 'enter')).toBe(false)
  })
})
