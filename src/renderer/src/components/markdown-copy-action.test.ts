import { expect, it } from 'vitest'
import { writeMarkdownClipboard } from './markdown-copy-action'
it('waits for clipboard completion and reports failure without rejection', async () => {
  let finish!: () => void
  let settled = false
  const result = writeMarkdownClipboard('exact\n\n', {
    writeText: (text) => {
      expect(text).toBe('exact\n\n')
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    }
  }).then((value) => {
    settled = true
    return value
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  finish()
  expect(await result).toBe(true)
  expect(
    await writeMarkdownClipboard('x', {
      writeText: async () => {
        throw new Error('denied')
      }
    })
  ).toBe(false)
  expect(await writeMarkdownClipboard('x', undefined)).toBe(false)
})
