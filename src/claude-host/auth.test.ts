import { expect, it } from 'vitest'
import { officialAuthUrl } from './auth'

it('recognizes current bundled Claude OAuth URL and legacy official hosts', () => {
  const url = 'https://claude.com/cai/oauth/authorize?client_id=fixture&state=fixture'
  expect(officialAuthUrl(`Open this URL:\n${url}\nWaiting for authorization…`)).toBe(url)
  expect(officialAuthUrl('https://claude.ai/oauth/authorize?state=old')).toBe(
    'https://claude.ai/oauth/authorize?state=old'
  )
  expect(officialAuthUrl('https://console.anthropic.com/oauth/authorize')).toBe(
    'https://console.anthropic.com/oauth/authorize'
  )
  expect(officialAuthUrl('https://platform.claude.com/oauth/authorize')).toBe(
    'https://platform.claude.com/oauth/authorize'
  )
})

it('rejects lookalike hostnames and non-HTTPS authorization links', () => {
  expect(officialAuthUrl('https://claude.com.example.com/cai/oauth/authorize')).toBeUndefined()
  expect(officialAuthUrl('https://claude.com@attacker.example/oauth/authorize')).toBeUndefined()
  expect(officialAuthUrl('http://claude.com/cai/oauth/authorize')).toBeUndefined()
})
