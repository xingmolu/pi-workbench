import { describe, expect, it } from 'vitest'
import type { HostCommand } from './contracts'
import { expectedHostResultKind, hostResultMatchesCommand } from './command-result'
import { hostCommandSchema, hostResultSchema } from './schemas'

describe('command result kinds', () => {
  it('requires the explicit fork outcome instead of a snapshot or acknowledgement', () => {
    const command: HostCommand = {
      type: 'session:fork',
      sessionId: 'source',
      generation: 1,
      entryId: 'leaf'
    }
    expect(expectedHostResultKind(command)).toBe('session-fork')
    expect(
      hostResultMatchesCommand(command, {
        kind: 'ack',
        sessionId: 'source',
        generation: 1,
        revision: 0
      })
    ).toBe(false)
  })
  it('uses explicit endpoint results and rejects metadata or result credential leakage', () => {
    const list: HostCommand = { type: 'endpoint:list' }
    const save: HostCommand = {
      type: 'endpoint:save',
      context: { projectPath: null, sessionId: null, generation: 0 },
      request: {
        expectedRevision: 'revision',
        endpoint: {
          label: 'fixture',
          api: 'openai-completions',
          baseUrl: 'https://example.invalid',
          modelIds: ['a'],
          key: 'secret-fixture'
        }
      }
    }
    expect(expectedHostResultKind(list)).toBe('endpoint-list')
    expect(expectedHostResultKind(save)).toBe('endpoint-save')
    expect(hostCommandSchema.safeParse(save).success).toBe(true)
    expect(hostCommandSchema.safeParse({ ...save, key: 'unexpected' }).success).toBe(false)
    expect(
      hostResultMatchesCommand(list, { kind: 'ack', sessionId: null, generation: 0, revision: 0 })
    ).toBe(false)
    expect(
      hostResultSchema.safeParse({
        kind: 'endpoint-list',
        configPath: '/fixture/models.json',
        snapshot: {
          revision: 'r',
          endpoints: [
            {
              id: 'custom-fixture',
              label: 'fixture',
              api: 'openai-completions',
              baseUrl: 'https://example.invalid',
              modelIds: ['a'],
              editable: true,
              unsupportedReason: null,
              key: 'leak'
            }
          ]
        }
      }).success
    ).toBe(false)
  })
  it('acknowledges canonical session rename', () => {
    expect(
      expectedHostResultKind({
        type: 'session:rename',
        sessionId: 'session-1',
        generation: 4,
        name: '新名字'
      })
    ).toBe('ack')
  })

  it('requires snapshots only for bootstrap and project/session boundaries', () => {
    const commands: HostCommand[] = [
      { type: 'bootstrap' },
      { type: 'state:get' },
      { type: 'project:open', cwd: '/tmp/project' },
      { type: 'session:new' },
      { type: 'session:open', path: '/tmp/session.jsonl' },
      { type: 'prompt:send', text: 'hello', sessionId: 'source', generation: 1 },
      { type: 'prompt:abort' },
      { type: 'queue:clear' },
      { type: 'permission:set', mode: 'ask' },
      { type: 'permission:respond', approvalId: 'approval-1', allow: true },
      { type: 'account:login', providerId: 'openai-codex', method: 'browser' },
      { type: 'account:login:respond', promptId: 'prompt-1' },
      { type: 'account:alias:add', slug: 'work' },
      { type: 'model:set', providerId: 'openai-codex', modelId: 'gpt-5' },
      { type: 'browser:e2e', operation: { action: 'snapshot' } }
    ]

    expect(commands.map(expectedHostResultKind)).toEqual([
      'snapshot',
      'snapshot',
      'snapshot',
      'snapshot',
      'snapshot',
      'ack',
      'ack',
      'ack',
      'ack',
      'ack',
      'ack',
      'ack',
      'ack',
      'ack',
      'ack'
    ])
  })
})
