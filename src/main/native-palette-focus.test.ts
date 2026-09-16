import { expect, it, vi } from 'vitest'
import { NativePaletteFocus } from './native-palette-focus'

it('restores the captured origin once, after the same native surface is visible again', () => {
  const focus = vi.fn()
  let visible = false
  const controller = new NativePaletteFocus()
  controller.capture('opaque-1', { valid: () => true, visible: () => visible, focus })
  controller.finish('opaque-1', true)
  expect(focus).not.toHaveBeenCalled()
  visible = true
  controller.surfaceUpdated()
  controller.surfaceUpdated()
  controller.finish('opaque-1', true)
  expect(focus).toHaveBeenCalledTimes(1)
})

it('does not restore a stale owner/session/view, discarded action, newer focus or expired request', () => {
  let now = 0
  const controller = new NativePaletteFocus(() => now)
  const focus = vi.fn()
  const target = { valid: () => true, visible: () => true, focus }
  controller.capture('action', target)
  controller.finish('action', false)
  controller.finish('action', true)
  controller.capture('invalid', { ...target, valid: () => false })
  controller.finish('invalid', true)
  controller.capture('old', target)
  controller.capture('new', target)
  controller.finish('old', true)
  controller.invalidate()
  controller.finish('new', true)
  controller.capture('expired', { ...target, visible: () => false })
  controller.finish('expired', true)
  now = 1001
  controller.surfaceUpdated()
  expect(focus).not.toHaveBeenCalled()
})

it('keeps the origin while typing in the palette but never steals newer focus after closing', () => {
  const focus = vi.fn()
  let visible = false
  const controller = new NativePaletteFocus()
  const target = { valid: () => true, visible: () => visible, focus }
  controller.capture('typing', target)
  controller.interruptPending()
  controller.finish('typing', true)
  visible = true
  controller.surfaceUpdated()
  expect(focus).toHaveBeenCalledTimes(1)
  visible = false
  controller.capture('cancelled', target)
  controller.finish('cancelled', true)
  controller.interruptPending()
  visible = true
  controller.surfaceUpdated()
  expect(focus).toHaveBeenCalledTimes(1)
})

it('expires an invisible restoration without letting duplicate finishes extend it', () => {
  let now = 0
  let visible = false
  const focus = vi.fn()
  const controller = new NativePaletteFocus(() => now)
  controller.capture('bounded', { valid: () => true, visible: () => visible, focus })
  controller.finish('bounded', true)
  now = 500
  controller.finish('bounded', true)
  visible = true
  now = 1001
  controller.surfaceUpdated()
  expect(focus).not.toHaveBeenCalled()
})
