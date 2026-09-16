import { expect, it } from 'vitest'
import { hostCommandSchema, hostRequestSchema, hostResultSchema } from './schemas'
import { expectedHostResultKind } from './command-result'

it('accepts settings commands across both IPC envelopes and their exact result kinds', () => {
  const identity = { sessionId: null, generation: 0 }
  const commands = [
    { type: 'mcp:list' },
    { type: 'mcp:shutdown' },
    { type: 'mcp:reload', ...identity },
    { type: 'mcp:toggle', ...identity, id: 'fixture', revision: 'revision', enabled: false },
    {
      type: 'mcp:save',
      ...identity,
      id: 'fixture',
      revision: 'revision',
      enabled: false,
      create: true,
      server: { command: 'node' }
    },
    { type: 'account:quota', providerId: 'openai-codex-work' }
  ]
  for (const value of commands) {
    const command = hostCommandSchema.parse(value)
    expect(hostRequestSchema.safeParse({ ...value, requestId: 'fixture-request' }).success).toBe(
      true
    )
    const result =
      value.type === 'account:quota'
        ? {
            kind: 'account-quota',
            quota: {
              providerId: 'openai-codex-work',
              authGeneration: 0,
              state: 'unavailable',
              fetchedAt: new Date(0).toISOString(),
              windows: []
            }
          }
        : { kind: 'mcp', result: { revision: '', writable: true, servers: [] } }
    expect(hostResultSchema.safeParse(result).success).toBe(true)
    expect(expectedHostResultKind(command)).toBe(result.kind)
  }
})
