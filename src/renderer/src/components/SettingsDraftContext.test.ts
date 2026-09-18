import { afterEach, expect, it, vi } from 'vitest'
import { confirmDiscardSettingsDraft, SETTINGS_DISCARD_MESSAGE } from './SettingsDraftContext'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('leaves clean settings without prompting', () => {
  expect(confirmDiscardSettingsDraft(false)).toBe(true)
})

it('requires explicit confirmation before discarding a dirty settings draft', () => {
  const confirm = vi.fn(() => false)
  vi.stubGlobal('window', { confirm })
  expect(confirmDiscardSettingsDraft(true)).toBe(false)
  expect(confirm).toHaveBeenCalledExactlyOnceWith(SETTINGS_DISCARD_MESSAGE)

  confirm.mockReturnValue(true)
  expect(confirmDiscardSettingsDraft(true)).toBe(true)
})
