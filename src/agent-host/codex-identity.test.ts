import { expect, it } from 'vitest'
import { codexIdentity } from './codex-identity'

const jwt = (claims: Record<string, unknown>): string =>
  ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.')

it('reads the account email and plan from the stored ChatGPT access token', () => {
  expect(
    codexIdentity(
      jwt({
        'https://api.openai.com/profile': { email: 'robin@example.com', email_verified: true },
        'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'acc' }
      })
    )
  ).toEqual({ email: 'robin@example.com', plan: 'Pro' })
})

it('falls back to a top-level email claim and keeps unknown plans readable', () => {
  expect(
    codexIdentity(
      jwt({ email: 'a@b.co', 'https://api.openai.com/auth': { chatgpt_plan_type: 'k12' } })
    )
  ).toEqual({ email: 'a@b.co', plan: 'k12' })
})

it('returns nothing for missing, malformed or non-email tokens', () => {
  expect(codexIdentity(undefined)).toEqual({})
  expect(codexIdentity('not-a-jwt')).toEqual({})
  expect(codexIdentity('a.!!!.c')).toEqual({})
  expect(codexIdentity(jwt({ 'https://api.openai.com/profile': { email: 'nobody' } }))).toEqual({})
})
