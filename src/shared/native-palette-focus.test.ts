import { expect, it } from 'vitest'
import { nativePaletteFocusSchema } from './native-palette-focus'

it('accepts only opaque completion or invalidation, never arbitrary WebContents or owner identifiers', () => {
  const command = { type: 'finish', token: '00000000-0000-4000-8000-000000000001', restore: true }
  expect(nativePaletteFocusSchema.safeParse(command).success).toBe(true)
  expect(nativePaletteFocusSchema.safeParse({ type: 'invalidate' }).success).toBe(true)
  for (const extra of [{ webContentsId: 7 }, { ownerId: 2 }, { target: 'browser' }])
    expect(nativePaletteFocusSchema.safeParse({ ...command, ...extra }).success).toBe(false)
  expect(
    nativePaletteFocusSchema.safeParse({ ...command, token: 'unbounded'.repeat(1000) }).success
  ).toBe(false)
})
