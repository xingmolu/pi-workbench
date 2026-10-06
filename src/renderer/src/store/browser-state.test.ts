import { describe, expect, it } from 'vitest'
import type { BrowserPageSummary } from '../../../shared/contracts'
import { addressTarget, forgetSite, rememberSites, useRecentSites } from './browser-state'

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

describe('rememberSites', () => {
  const page = (id: string, url: string, title: string, loading = false): BrowserPageSummary => ({
    id,
    url,
    title,
    loading,
    active: false,
    canGoBack: false,
    canGoForward: false
  })

  it('keeps loaded web pages, the active one first, without duplicates', () => {
    useRecentSites.setState({ sites: [{ url: 'https://old.dev/', title: 'Old' }] })
    rememberSites({
      available: true,
      visible: true,
      controller: 'idle',
      activePageId: 'b',
      pages: [
        page('a', 'https://a.dev/', 'A'),
        page('b', 'https://b.dev/', 'B'),
        page('c', 'about:blank', 'about:blank'),
        page('d', 'https://d.dev/', 'D', true)
      ]
    })
    expect(useRecentSites.getState().sites.map(({ title }) => title)).toEqual(['B', 'A', 'Old'])
    forgetSite('https://a.dev/')
    expect(useRecentSites.getState().sites.map(({ title }) => title)).toEqual(['B', 'Old'])
  })
})
