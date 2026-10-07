import { describe, expect, it } from 'vitest'
import type { UtilityCompleteCommand, UtilityCompletion } from '../shared/utility-model'
import { UtilityBusyError, UtilityModelService } from './utility-model-service'

function deferred(): {
  promise: Promise<UtilityCompletion>
  resolve: (value: UtilityCompletion) => void
} {
  let resolve!: (value: UtilityCompletion) => void
  const promise = new Promise<UtilityCompletion>((done) => (resolve = done))
  return { promise, resolve }
}

const done: UtilityCompletion = { text: 'ok', providerId: 'p', modelId: 'm' }

describe('UtilityModelService', () => {
  it('sends the user choice first and the session model as the fallback, in its worker', async () => {
    const sent: UtilityCompleteCommand[] = []
    const workers: (string | undefined)[] = []
    const service = new UtilityModelService({
      run: async (command, worker) => {
        sent.push(command)
        workers.push(worker)
        return done
      },
      preferred: () => ({ providerId: 'deepseek', modelId: 'deepseek-chat' })
    })
    await service.complete('session-title', {
      system: 'Name it',
      prompt: 'Fix login',
      maxTokens: 200,
      fallback: { providerId: 'anthropic', modelId: 'claude-opus-5-5' },
      worker: 'w1'
    })
    expect(workers).toEqual(['w1'])
    expect(sent).toEqual([
      {
        type: 'utility:complete',
        system: 'Name it',
        prompt: 'Fix login',
        maxTokens: 200,
        preferred: [{ providerId: 'deepseek', modelId: 'deepseek-chat' }],
        fallback: { providerId: 'anthropic', modelId: 'claude-opus-5-5' }
      }
    ])
  })

  it('runs one request per caller at a time and frees the slot when it ends', async () => {
    const pending = deferred()
    const service = new UtilityModelService({ run: () => pending.promise, preferred: () => null })
    const first = service.complete('plugin:acme.git', { prompt: 'a', maxTokens: 100 })
    await expect(
      service.complete('plugin:acme.git', { prompt: 'b', maxTokens: 100 })
    ).rejects.toBeInstanceOf(UtilityBusyError)
    // Another caller is not held up by it.
    const other = service.complete('session-title', { prompt: 'c', maxTokens: 100 })
    pending.resolve(done)
    await expect(first).resolves.toEqual(done)
    await expect(other).resolves.toEqual(done)
    await expect(
      service.complete('plugin:acme.git', { prompt: 'd', maxTokens: 100 })
    ).resolves.toEqual(done)
  })

  it('caps how many requests run at once across callers', async () => {
    const pending = deferred()
    const service = new UtilityModelService({
      run: () => pending.promise,
      preferred: () => null,
      maxConcurrent: 2
    })
    const running = [
      service.complete('a', { prompt: 'x', maxTokens: 100 }),
      service.complete('b', { prompt: 'x', maxTokens: 100 })
    ]
    await expect(service.complete('c', { prompt: 'x', maxTokens: 100 })).rejects.toBeInstanceOf(
      UtilityBusyError
    )
    pending.resolve(done)
    await Promise.all(running)
  })

  it('frees the slot after a failure too', async () => {
    let fail = true
    const service = new UtilityModelService({
      run: async () => {
        if (fail) throw new Error('down')
        return done
      },
      preferred: () => null
    })
    await expect(service.complete('a', { prompt: 'x', maxTokens: 100 })).rejects.toThrow('down')
    fail = false
    await expect(service.complete('a', { prompt: 'x', maxTokens: 100 })).resolves.toEqual(done)
  })
})
