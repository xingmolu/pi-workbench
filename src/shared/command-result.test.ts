import { describe, expect, it } from 'vitest'
import type { HostCommand } from './contracts'
import { expectedHostResultKind } from './command-result'

describe('command result kinds', () => {
  it('requires snapshots only for bootstrap and project/session boundaries', () => {
    const commands: HostCommand[] = [
      { type: 'bootstrap' },
      { type: 'state:get' },
      { type: 'project:open', cwd: '/tmp/project' },
      { type: 'session:new' },
      { type: 'session:open', path: '/tmp/session.jsonl' },
      { type: 'prompt:send', text: 'hello' },
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
