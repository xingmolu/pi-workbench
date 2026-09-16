import { describe, expect, it } from 'vitest'
import { normalizeSessionName } from './session-name'

describe('normalizeSessionName', () => {
  it('trims a Chinese name', () => {
    expect(normalizeSessionName('  会话重命名  ')).toBe('会话重命名')
  })

  it.each(['中', '😀'])('accepts 80 Unicode code points of %s', (character) => {
    expect(normalizeSessionName(` ${character.repeat(80)} `)).toBe(character.repeat(80))
  })

  it.each(['中', '😀'])('rejects 81 Unicode code points of %s', (character) => {
    expect(() => normalizeSessionName(character.repeat(81))).toThrow('80')
  })

  it.each([
    '',
    '   ',
    '\nname',
    'name\n',
    'a\rb',
    'a\tb',
    'a\0b',
    'a\u007fb',
    'a\u0085b',
    'a\u2028b',
    'a\u2029b'
  ])('rejects empty or control-containing input %j', (name) =>
    expect(() => normalizeSessionName(name)).toThrow()
  )

  it('bounds raw input even if most of it would be trimmed', () => {
    expect(() => normalizeSessionName(`${' '.repeat(4096)}a`)).toThrow()
  })
})
