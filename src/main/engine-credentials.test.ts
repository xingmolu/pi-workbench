import { expect, it } from 'vitest'
import { EngineCredentialBroker } from './engine-credentials'
import type { CredentialGrant, CredentialGrantDecision } from '../shared/engine-credentials'

function setup(decisions: CredentialGrantDecision[]) {
  let grants: CredentialGrant[] = []
  const asked: string[] = []
  const broker = new EngineCredentialBroker({
    accounts: async () => [
      {
        id: 'openai-codex',
        name: 'a',
        authType: 'oauth',
        connected: true,
        subscription: true,
        alias: false,
        platform: 'chatgpt',
        email: 'Robin@Example.com',
        plan: 'Plus'
      },
      {
        id: 'claude',
        name: 'c',
        authType: 'oauth',
        connected: true,
        subscription: true,
        alias: false,
        platform: 'claude',
        email: 'c@example.com'
      }
    ],
    token: async (id) => ({
      accessToken: `token-${id}`,
      chatgptAccountId: 'acct',
      planType: 'plus'
    }),
    grants: { read: () => grants, write: (next) => (grants = next) },
    ask: async (prompt) => {
      asked.push(`${prompt.runtimeLabel}:${prompt.email}`)
      return decisions.shift() ?? 'deny'
    },
    label: () => 'Codex'
  })
  return { broker, asked, grants: () => grants }
}

it('lends only ChatGPT logins and asks before the first token', async () => {
  const { broker, asked, grants } = setup(['once', 'always'])
  expect(await broker.list('codex')).toEqual([
    { id: 'openai-codex', email: 'Robin@Example.com', plan: 'Plus', granted: false }
  ])
  // Two concurrent requests share one dialog.
  const [first, second] = await Promise.all([
    broker.token('codex', 'openai-codex'),
    broker.token('codex', 'openai-codex')
  ])
  expect(first.accessToken).toBe('token-openai-codex')
  expect(second.accessToken).toBe('token-openai-codex')
  expect(asked).toEqual(['Codex:Robin@Example.com'])
  // "Once" lasts for this run only; nothing durable was stored.
  expect(grants()).toEqual([])
  expect((await broker.list('codex'))[0]!.granted).toBe(true)
  await expect(broker.token('codex', 'claude')).rejects.toThrow('不在 Pi 中')
})

it('remembers "always", keyed by email, and forgets it on revoke', async () => {
  const { broker, asked, grants } = setup(['always', 'deny'])
  await broker.token('codex', 'openai-codex')
  expect(grants()).toEqual([{ runtimeId: 'codex', account: 'robin@example.com' }])
  await broker.token('codex', 'openai-codex')
  expect(asked).toHaveLength(1)
  broker.revoke('codex', 'robin@example.com')
  await expect(broker.token('codex', 'openai-codex')).rejects.toThrow('没有允许 Codex')
  expect(asked).toHaveLength(2)
})

it('answers host requests on the credential channel and ignores other messages', async () => {
  const { broker } = setup(['always'])
  const replies: unknown[] = []
  expect(broker.handle('codex', { type: 'other' }, (message) => replies.push(message))).toBe(false)
  expect(
    broker.handle(
      'codex',
      {
        type: 'credential:request',
        requestId: 'r1',
        kind: 'chatgpt-token',
        accountId: 'openai-codex',
        reason: 'start'
      },
      (message) => replies.push(message)
    )
  ).toBe(true)
  await expect
    .poll(() => replies)
    .toEqual([
      {
        type: 'credential:response',
        requestId: 'r1',
        ok: true,
        data: { accessToken: 'token-openai-codex', chatgptAccountId: 'acct', planType: 'plus' }
      }
    ])
})
