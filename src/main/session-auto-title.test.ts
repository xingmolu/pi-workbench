import { describe, expect, it, vi } from 'vitest'
import type { AgentSnapshot, ConversationNode, SessionStatus } from '../shared/contracts'
import { createEmptyAgentSnapshot } from '../shared/initial-agent-snapshot'
import { PI_RUNTIME_MANIFEST } from '../shared/pi-runtime'
import { SessionAutoTitler, type SessionAutoTitlerOptions } from './session-auto-title'

const user = (text: string): ConversationNode => ({ id: `u-${text}`, type: 'user', text })
const reply = (markdown: string): ConversationNode => ({
  id: `a-${markdown}`,
  type: 'assistant',
  markdown
})

function snapshot(
  status: SessionStatus,
  nodes: ConversationNode[],
  overrides: Partial<AgentSnapshot> = {}
): AgentSnapshot {
  return {
    ...createEmptyAgentSnapshot('pi', '/agent'),
    runtime: PI_RUNTIME_MANIFEST,
    project: { path: '/work/shop', name: 'shop' } as AgentSnapshot['project'],
    sessionId: nodes.length ? 's1' : null,
    activeSessionPath: nodes.length ? '/sessions/s1.jsonl' : null,
    activeProvider: 'gateway',
    activeModel: 'big',
    status,
    nodes,
    ...overrides
  }
}

function setup(overrides: Partial<SessionAutoTitlerOptions> = {}): {
  titler: SessionAutoTitler
  renamed: { path: string; title: string }[]
  generate: ReturnType<typeof vi.fn>
} {
  const renamed: { path: string; title: string }[] = []
  const generate = vi.fn(async () => 'Fix login redirect')
  const titler = new SessionAutoTitler({
    enabled: () => true,
    isTaskWorker: () => false,
    generate,
    rename: async (target, title) => {
      renamed.push({ path: target.path, title })
    },
    ...overrides
  })
  return { titler, renamed, generate }
}

const flush = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0))

/** A new conversation in worker w1: empty, the first turn running, then settled. */
function firstTurn(titler: SessionAutoTitler, end: SessionStatus = 'idle'): void {
  titler.observe('w1', snapshot('idle', []))
  titler.observe('w1', snapshot('running', [user('The login page loops')]))
  titler.observe('w1', snapshot('running', [user('The login page loops'), reply('Looking')]))
  titler.observe('w1', snapshot(end, [user('The login page loops'), reply('Fixed the redirect')]))
}

describe('SessionAutoTitler', () => {
  it('names a new conversation once its first turn ends', async () => {
    const { titler, renamed, generate } = setup()
    firstTurn(titler)
    await flush()
    expect(generate).toHaveBeenCalledWith({
      firstMessage: 'The login page loops',
      reply: 'Fixed the redirect',
      fallback: { providerId: 'gateway', modelId: 'big' },
      worker: 'w1'
    })
    expect(renamed).toEqual([{ path: '/sessions/s1.jsonl', title: 'Fix login redirect' }])
    // Later turns leave the title alone.
    titler.observe('w1', snapshot('running', [user('The login page loops'), user('And logout')]))
    titler.observe('w1', snapshot('idle', [user('The login page loops'), user('And logout')]))
    await flush()
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('never names a conversation opened from history', async () => {
    const { titler, generate } = setup()
    titler.observe('w1', snapshot('idle', []))
    // Opening saved history: messages appear without a turn running here.
    titler.observe('w1', snapshot('idle', [user('Old question'), reply('Old answer')]))
    titler.observe('w1', snapshot('running', [user('Old question'), user('Follow-up')]))
    titler.observe('w1', snapshot('idle', [user('Old question'), user('Follow-up')]))
    // A worker first seen with history is not ours to name either.
    titler.observe('w2', snapshot('running', [user('Other')]))
    titler.observe('w2', snapshot('idle', [user('Other'), reply('Done')]))
    await flush()
    expect(generate).not.toHaveBeenCalled()
  })

  it('keeps a name the user gave, before or while the title is written', async () => {
    const before = setup()
    before.titler.userRenamed('/sessions/s1.jsonl')
    firstTurn(before.titler)
    await flush()
    expect(before.generate).not.toHaveBeenCalled()

    let finish!: (title: string) => void
    const during = setup({
      generate: () => new Promise<string>((resolve) => (finish = resolve))
    })
    firstTurn(during.titler)
    during.titler.userRenamed('/sessions/s1.jsonl')
    finish('Fix login redirect')
    await flush()
    expect(during.renamed).toEqual([])
  })

  it('leaves failed or stopped first turns, task workers and a switched-off setting alone', async () => {
    for (const end of ['error', 'stopped'] as const) {
      const { titler, generate } = setup()
      firstTurn(titler, end)
      await flush()
      expect(generate).not.toHaveBeenCalled()
    }
    const task = setup({ isTaskWorker: () => true })
    firstTurn(task.titler)
    const off = setup({ enabled: () => false })
    firstTurn(off.titler)
    await flush()
    expect(task.generate).not.toHaveBeenCalled()
    expect(off.generate).not.toHaveBeenCalled()
  })

  it('does not name a different conversation the worker moved to mid-turn', async () => {
    const { titler, generate } = setup()
    titler.observe('w1', snapshot('idle', []))
    titler.observe('w1', snapshot('running', [user('First')]))
    titler.observe(
      'w1',
      snapshot('idle', [user('Elsewhere'), reply('Answer')], {
        sessionId: 's2',
        activeSessionPath: '/sessions/s2.jsonl'
      })
    )
    await flush()
    expect(generate).not.toHaveBeenCalled()
  })

  it('runs other engines in Pi itself, without their model as a fallback', async () => {
    const { titler, generate } = setup()
    const claude = { ...PI_RUNTIME_MANIFEST, id: 'claude' }
    titler.observe('w1', snapshot('idle', [], { runtime: claude }))
    titler.observe('w1', snapshot('running', [user('Hi')], { runtime: claude }))
    titler.observe('w1', snapshot('idle', [user('Hi'), reply('Hello')], { runtime: claude }))
    await flush()
    expect(generate).toHaveBeenCalledWith({ firstMessage: 'Hi', reply: 'Hello' })
  })

  it('reports a failed generation without renaming', async () => {
    const onError = vi.fn()
    const { titler, renamed } = setup({
      generate: async () => {
        throw new Error('no model')
      },
      onError
    })
    firstTurn(titler)
    await flush()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'no model' }))
    expect(renamed).toEqual([])
  })

  it('does not rename with an empty title', async () => {
    const { titler, renamed } = setup({ generate: async () => '' })
    firstTurn(titler)
    await flush()
    expect(renamed).toEqual([])
  })
})
