import { describe, expect, it } from 'vitest'
import {
  browserPartitionForProject,
  isAllowedBrowserKey,
  normalizeBrowserUrl
} from './browser-security'

describe('browser security helpers', () => {
  it('normalizes HTTPS and local development URLs', () => {
    expect(normalizeBrowserUrl('example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeBrowserUrl('example.com:8443/docs')).toBe('https://example.com:8443/docs')
    expect(normalizeBrowserUrl('localhost:4173/demo')).toBe('http://localhost:4173/demo')
    expect(normalizeBrowserUrl('127.0.0.1:4312')).toBe('http://127.0.0.1:4312/')
  })

  it('rejects unsafe schemes, credentials, and remote HTTP', () => {
    expect(() => normalizeBrowserUrl('javascript:alert(1)')).toThrow('HTTP')
    expect(() => normalizeBrowserUrl('file:///tmp/private')).toThrow('HTTP')
    expect(() => normalizeBrowserUrl('https://user:secret@example.com')).toThrow('账号或密码')
    expect(() => normalizeBrowserUrl('http://example.com')).toThrow('HTTPS')
  })

  it('creates stable project-scoped partitions without exposing the path', () => {
    const partition = browserPartitionForProject('/Users/example/work')
    expect(partition).toMatch(/^persist:pi-browser-[a-f0-9]{20}$/)
    expect(partition).toBe(browserPartitionForProject('/Users/example/work'))
    expect(partition).not.toContain('Users')
  })

  it('limits synthetic key input to ordinary browser keys', () => {
    expect(isAllowedBrowserKey('Enter')).toBe(true)
    expect(isAllowedBrowserKey('a')).toBe(true)
    expect(isAllowedBrowserKey('\n')).toBe(false)
    expect(isAllowedBrowserKey('F12')).toBe(false)
  })
})
