import { describe, expect, it } from 'vitest'
import type { LoginPrompt } from '../shared/contracts'
import { LoginPromptRegistry } from './login-prompt-registry'

function prompt(type: LoginPrompt['type'] = 'manual_code'): LoginPrompt {
  return {
    id: 'prompt-1',
    providerId: 'openai-codex',
    type,
    message: 'Continue login'
  }
}

describe('LoginPromptRegistry', () => {
  it('publishes a manual prompt and clears it after success', async () => {
    const states: Array<LoginPrompt | null> = []
    const registry = new LoginPromptRegistry((state) => states.push(state))
    const pending = registry.request(prompt())

    expect(registry.current).toEqual(prompt())
    expect(registry.resolve('prompt-1', 'code')).toBe(true)
    await expect(pending).resolves.toBe('code')
    expect(states).toEqual([prompt(), null])
  })

  it('clears a browser fallback prompt when its signal aborts', async () => {
    const states: Array<LoginPrompt | null> = []
    const registry = new LoginPromptRegistry((state) => states.push(state))
    const controller = new AbortController()
    const pending = registry.request(prompt('select'), controller.signal)

    controller.abort()

    await expect(pending).resolves.toBe('')
    expect(registry.current).toBeNull()
    expect(states.at(-1)).toBeNull()
  })

  it('clears an outstanding prompt when login fails', async () => {
    const states: Array<LoginPrompt | null> = []
    const registry = new LoginPromptRegistry((state) => states.push(state))
    const pending = registry.request(prompt())

    registry.clear()

    await expect(pending).resolves.toBe('')
    expect(registry.current).toBeNull()
    expect(states.at(-1)).toBeNull()
  })
})
