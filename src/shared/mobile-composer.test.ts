import { describe, expect, it } from 'vitest'
import { composeBlockChip, composerShouldSend } from './mobile-composer'

describe('mobile composer keys', () => {
  it('sends on Enter and modifier-Enter, but not Shift+Enter or IME composition', () => {
    expect(composerShouldSend({ key: 'Enter' })).toBe(true)
    expect(composerShouldSend({ key: 'Enter', shiftKey: false })).toBe(true)
    expect(composerShouldSend({ key: 'Enter', shiftKey: true })).toBe(false)
    expect(composerShouldSend({ key: 'Enter', altKey: true })).toBe(false)
    expect(composerShouldSend({ key: 'Enter', isComposing: true })).toBe(false)
    expect(composerShouldSend({ key: 'Enter', keyCode: 229 })).toBe(false)
    expect(composerShouldSend({ key: 'a' })).toBe(false)
  })

  it('maps compose-block reasons to a compact chip', () => {
    expect(composeBlockChip(null)).toBe('')
    expect(composeBlockChip('pinned-model-unavailable')).toBe('模型不可用')
    expect(composeBlockChip('other')).toBe('暂时无法发送')
  })
})
