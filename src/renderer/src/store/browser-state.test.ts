import { describe, expect, it } from 'vitest'
import { addressTarget } from './browser-state'

describe('addressTarget', () => {
  it('keeps addresses and searches everything else', () => {
    expect(addressTarget('https://example.com/a')).toBe('https://example.com/a')
    expect(addressTarget('example.com')).toBe('example.com')
    expect(addressTarget('docs.example.co.uk/path?q=1')).toBe('docs.example.co.uk/path?q=1')
    expect(addressTarget('localhost:5173')).toBe('localhost:5173')
    expect(addressTarget('127.0.0.1:8080/app')).toBe('127.0.0.1:8080/app')
    expect(addressTarget('about:blank')).toBe('about:blank')
    expect(addressTarget('react hooks')).toBe('https://www.bing.com/search?q=react%20hooks')
    expect(addressTarget('电子表格')).toBe(
      `https://www.bing.com/search?q=${encodeURIComponent('电子表格')}`
    )
    expect(addressTarget('readme.md is long')).toContain('bing.com/search')
  })
})
