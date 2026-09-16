import { describe, expect, it, vi } from 'vitest'
import type { HostCommand } from '../shared/contracts'
import { SerialExecutor } from './serial-executor'
import { assertPromptIdentity } from './session-fork'
import {
  runPreparedSessionReplacement,
  runSessionReplacement,
  usesSessionTransition
} from './session-transition'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('SerialExecutor', () => {
  it('serializes edit preparation/send while query, cancel and Stop remain nonblocking', () => {
    expect(
      usesSessionTransition({
        type: 'session:edit:prepare',
        sessionId: 's',
        generation: 1,
        entryId: 'user',
        leafId: null
      })
    ).toBe(true)
    expect(
      usesSessionTransition({
        type: 'session:edit:send',
        token: 't',
        submissionId: 'id',
        text: 'x'
      })
    ).toBe(true)
    expect(usesSessionTransition({ type: 'session:edit:query', submissionId: 'id' })).toBe(false)
    expect(usesSessionTransition({ type: 'session:edit:cancel', token: 't' })).toBe(false)
  })
  it('serializes endpoint save with login starts and aliases but leaves OAuth and permission responders nonblocking', async () => {
    expect(
      usesSessionTransition({
        type: 'endpoint:save',
        context: { projectPath: null, sessionId: null, generation: 0 },
        request: {
          expectedRevision: '0',
          endpoint: {
            label: 'test',
            api: 'openai-completions',
            baseUrl: 'https://example.invalid',
            modelIds: ['a'],
            key: 'fixture'
          }
        }
      })
    ).toBe(true)
    expect(
      usesSessionTransition({
        type: 'account:login',
        providerId: 'openai-codex',
        method: 'browser'
      })
    ).toBe(true)
    expect(usesSessionTransition({ type: 'account:alias:add', slug: 'work' })).toBe(true)
    expect(usesSessionTransition({ type: 'account:login:respond', promptId: 'login' })).toBe(false)
    expect(
      usesSessionTransition({ type: 'permission:respond', approvalId: 'approve', allow: true })
    ).toBe(false)
    expect(usesSessionTransition({ type: 'prompt:abort' })).toBe(false)
    const executor = new SerialExecutor()
    const gate = deferred<void>()
    const calls: string[] = []
    const save = executor.run(async () => {
      calls.push('save:start')
      await gate.promise
      calls.push('save:refresh')
    })
    const login = executor.run(async () => {
      calls.push('login:start')
    })
    const alias = executor.run(async () => {
      calls.push('alias:reload')
    })
    await Promise.resolve()
    expect(calls).toEqual(['save:start'])
    gate.resolve()
    await Promise.all([save, login, alias])
    expect(calls).toEqual(['save:start', 'save:refresh', 'login:start', 'alias:reload'])
  })
  it('preserves request order when underlying work completes in reverse order', async () => {
    const executor = new SerialExecutor()
    const firstGate = deferred<string>()
    const secondGate = deferred<string>()
    const order: string[] = []

    const first = executor.run(async () => {
      order.push('first:start')
      const value = await firstGate.promise
      order.push('first:end')
      return value
    })
    const second = executor.run(async () => {
      order.push('second:start')
      const value = await secondGate.promise
      order.push('second:end')
      return value
    })

    secondGate.resolve('second')
    await Promise.resolve()
    expect(order).toEqual(['first:start'])

    firstGate.resolve('first')
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('classifies model changes and session replacements on the same transition queue', () => {
    expect([
      usesSessionTransition({ type: 'project:open', cwd: '/tmp/project' }),
      usesSessionTransition({ type: 'session:new' }),
      usesSessionTransition({ type: 'session:open', path: '/tmp/session.jsonl' }),
      usesSessionTransition({
        type: 'model:set',
        providerId: 'openai-codex-work',
        modelId: 'gpt-5.6-sol'
      })
    ]).toEqual([true, true, true, true])
    expect(
      usesSessionTransition({
        type: 'prompt:send',
        text: 'hello',
        sessionId: 'source',
        generation: 1
      })
    ).toBe(true)
    expect(
      usesSessionTransition({
        type: 'session:rename',
        sessionId: 'session-1',
        generation: 4,
        name: '新名字'
      })
    ).toBe(true)
  })

  it('rejects an old prompt queued during session:new and accepts an explicitly scoped child prompt', async () => {
    const executor = new SerialExecutor()
    const bindNewSession = deferred<void>()
    const outgoingSession = {
      prompt: vi.fn(async (text: string) => {
        void text
      })
    }
    const incomingSession = {
      prompt: vi.fn(async (text: string) => {
        void text
      })
    }
    let activeSession = outgoingSession
    const dispatch = <Result>(
      command: HostCommand,
      task: () => Promise<Result>
    ): Promise<Result> => (usesSessionTransition(command) ? executor.run(task) : task())

    const replacement = dispatch(
      {
        type: 'session:new',
        providerId: 'openai-codex-work',
        modelId: 'gpt-5.6-sol'
      },
      async () => {
        await bindNewSession.promise
        activeSession = incomingSession
      }
    )
    const expected = { sessionId: 'source', generation: 1 }
    const prompt = dispatch(
      { type: 'prompt:send', text: 'hello new session', ...expected },
      async () => {
        assertPromptIdentity(
          expected,
          activeSession === outgoingSession ? expected : { sessionId: 'child', generation: 2 }
        )
        await activeSession.prompt('hello new session')
      }
    )

    await Promise.resolve()
    expect(outgoingSession.prompt).not.toHaveBeenCalled()
    expect(incomingSession.prompt).not.toHaveBeenCalled()

    bindNewSession.resolve()
    await replacement
    await expect(prompt).rejects.toThrow('会话已切换')
    expect(outgoingSession.prompt).not.toHaveBeenCalled()
    expect(incomingSession.prompt).not.toHaveBeenCalled()
    await executor.run(async () => {
      assertPromptIdentity(
        { sessionId: 'child', generation: 2 },
        { sessionId: 'child', generation: 2 }
      )
      await activeSession.prompt('hello new session')
    })
    expect(incomingSession.prompt).toHaveBeenCalledWith('hello new session')
  })

  it.each(['session:new', 'session:open'] as const)(
    'does not start %s while an earlier model:set is validating',
    async (replacement) => {
      const executor = new SerialExecutor()
      const validation = deferred<void>()
      const order: string[] = []
      const modelSet = executor.run(async () => {
        order.push('model:set:start')
        await validation.promise
        order.push('model:set:end')
      })
      const sessionReplacement = executor.run(async () => {
        order.push(replacement)
      })

      await Promise.resolve()
      expect(order).toEqual(['model:set:start'])
      validation.resolve()
      await Promise.all([modelSet, sessionReplacement])
      expect(order).toEqual(['model:set:start', 'model:set:end', replacement])
    }
  )

  it('applies two model:set requests in arrival order', async () => {
    const executor = new SerialExecutor()
    const firstValidation = deferred<void>()
    const order: string[] = []
    const first = executor.run(async () => {
      order.push('sol:start')
      await firstValidation.promise
      order.push('sol:apply')
    })
    const second = executor.run(async () => {
      order.push('luna:apply')
    })

    await Promise.resolve()
    expect(order).toEqual(['sol:start'])
    firstValidation.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['sol:start', 'sol:apply', 'luna:apply'])
  })

  it('publishes the rebound generation when post-bind session refresh fails', async () => {
    let generation = 8
    const publishSnapshot = vi.fn()
    const recoverInvalidatedSession = vi.fn()

    await expect(
      runSessionReplacement({
        generationBeforeReplacement: generation,
        invalidationBeforeReplacement: 3,
        replaceSession: async () => {
          generation += 1
          return { cancelled: false }
        },
        refreshSessions: async () => {
          throw new Error('session list unavailable')
        },
        readGeneration: () => generation,
        readInvalidation: () => 4,
        recoverInvalidatedSession,
        clearSessionAfterRecoveryFailure: vi.fn(),
        publishSnapshot
      })
    ).rejects.toThrow('session list unavailable')

    expect(recoverInvalidatedSession).not.toHaveBeenCalled()
    expect(publishSnapshot).toHaveBeenCalledOnce()
  })

  it('keeps the current runtime intact when preparing a project replacement fails', async () => {
    const mutate = vi.fn()
    const publishSnapshot = vi.fn()

    await expect(
      runPreparedSessionReplacement({
        generationBeforeReplacement: 8,
        prepare: async () => {
          throw new Error('runtime create failed')
        },
        commit: mutate,
        readGeneration: () => 8,
        publishSnapshot
      })
    ).rejects.toThrow('runtime create failed')

    expect(mutate).not.toHaveBeenCalled()
    expect(publishSnapshot).not.toHaveBeenCalled()
  })

  it('publishes the new project generation when post-bind refresh fails', async () => {
    let generation = 8
    const publishSnapshot = vi.fn()

    await expect(
      runPreparedSessionReplacement({
        generationBeforeReplacement: generation,
        prepare: async () => 'prepared-runtime',
        commit: async () => {
          generation += 1
          throw new Error('project session list unavailable')
        },
        readGeneration: () => generation,
        publishSnapshot
      })
    ).rejects.toThrow('project session list unavailable')

    expect(publishSnapshot).toHaveBeenCalledOnce()
  })

  it('publishes a snapshot when switchSession throws after rebinding', async () => {
    let generation = 8
    const publishSnapshot = vi.fn()
    const recoverInvalidatedSession = vi.fn()

    await expect(
      runSessionReplacement({
        generationBeforeReplacement: generation,
        invalidationBeforeReplacement: 3,
        replaceSession: async () => {
          generation += 1
          throw new Error('switch failed after rebind')
        },
        refreshSessions: async () => undefined,
        readGeneration: () => generation,
        readInvalidation: () => 4,
        recoverInvalidatedSession,
        clearSessionAfterRecoveryFailure: vi.fn(),
        publishSnapshot
      })
    ).rejects.toThrow('switch failed after rebind')

    expect(recoverInvalidatedSession).not.toHaveBeenCalled()
    expect(publishSnapshot).toHaveBeenCalledOnce()
  })

  it('rebuilds the outgoing session when replacement fails after SDK invalidation', async () => {
    const recoverInvalidatedSession = vi.fn(async () => undefined)
    const clearSessionAfterRecoveryFailure = vi.fn(async () => undefined)
    const publishSnapshot = vi.fn()

    await expect(
      runSessionReplacement({
        generationBeforeReplacement: 8,
        invalidationBeforeReplacement: 3,
        replaceSession: async () => {
          throw new Error('runtime create failed after teardown')
        },
        refreshSessions: async () => undefined,
        readGeneration: () => 8,
        readInvalidation: () => 4,
        recoverInvalidatedSession,
        clearSessionAfterRecoveryFailure,
        publishSnapshot
      })
    ).rejects.toThrow('runtime create failed after teardown')

    expect(recoverInvalidatedSession).toHaveBeenCalledOnce()
    expect(clearSessionAfterRecoveryFailure).not.toHaveBeenCalled()
    expect(publishSnapshot).toHaveBeenCalledOnce()
  })

  it('publishes a projectless snapshot when rebuilding an invalidated runtime also fails', async () => {
    let projectPath: string | null = '/tmp/project'
    let publishedProjectPath: string | null | undefined
    const clearSessionAfterRecoveryFailure = vi.fn(async () => {
      projectPath = null
    })
    const publishSnapshot = vi.fn(() => {
      publishedProjectPath = projectPath
    })

    await expect(
      runSessionReplacement({
        generationBeforeReplacement: 8,
        invalidationBeforeReplacement: 3,
        replaceSession: async () => {
          throw new Error('replacement failed')
        },
        refreshSessions: async () => undefined,
        readGeneration: () => 8,
        readInvalidation: () => 4,
        recoverInvalidatedSession: async () => {
          throw new Error('recovery failed')
        },
        clearSessionAfterRecoveryFailure,
        publishSnapshot
      })
    ).rejects.toThrow('replacement failed')

    expect(clearSessionAfterRecoveryFailure).toHaveBeenCalledOnce()
    expect(publishSnapshot).toHaveBeenCalledOnce()
    expect(publishedProjectPath).toBeNull()
  })

  it('leaves an intact session alone when replacement fails before invalidation', async () => {
    const recoverInvalidatedSession = vi.fn(async () => undefined)
    const publishSnapshot = vi.fn()

    await expect(
      runSessionReplacement({
        generationBeforeReplacement: 8,
        invalidationBeforeReplacement: 3,
        replaceSession: async () => {
          throw new Error('invalid session path')
        },
        refreshSessions: async () => undefined,
        readGeneration: () => 8,
        readInvalidation: () => 3,
        recoverInvalidatedSession,
        clearSessionAfterRecoveryFailure: vi.fn(),
        publishSnapshot
      })
    ).rejects.toThrow('invalid session path')

    expect(recoverInvalidatedSession).not.toHaveBeenCalled()
    expect(publishSnapshot).not.toHaveBeenCalled()
  })
})
