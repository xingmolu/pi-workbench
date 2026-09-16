import { describe, expect, it } from 'vitest'
import { selectProjectedProviders, shouldProjectAccount } from './auth-projection'

describe('composer account projection', () => {
  it('keeps Codex family and auth.json-backed providers', () => {
    expect(
      shouldProjectAccount({
        providerId: 'openai-codex',
        hasStoredCredential: false,
        modelsJsonProvider: false,
        runtimeAvailable: false
      })
    ).toBe(true)
    expect(
      shouldProjectAccount({
        providerId: 'openai-codex-home',
        hasStoredCredential: false,
        modelsJsonProvider: false,
        runtimeAvailable: false
      })
    ).toBe(true)
    expect(
      shouldProjectAccount({
        providerId: 'custom-11111111-2222-4333-8444-555555555555',
        hasStoredCredential: true,
        modelsJsonProvider: true,
        runtimeAvailable: true
      })
    ).toBe(true)
  })

  it('includes CLI models.json providers only when the runtime has available models', () => {
    expect(
      shouldProjectAccount({
        providerId: 'athenai',
        hasStoredCredential: false,
        modelsJsonProvider: true,
        runtimeAvailable: true
      })
    ).toBe(true)
    expect(
      shouldProjectAccount({
        providerId: 'athenai',
        hasStoredCredential: false,
        modelsJsonProvider: true,
        runtimeAvailable: false
      })
    ).toBe(false)
  })

  it('does not project built-in or extension providers that lack stored auth and models.json', () => {
    expect(
      shouldProjectAccount({
        providerId: 'anthropic',
        hasStoredCredential: false,
        modelsJsonProvider: false,
        runtimeAvailable: true
      })
    ).toBe(false)
    expect(
      shouldProjectAccount({
        providerId: 'endpoint-faux',
        hasStoredCredential: false,
        modelsJsonProvider: false,
        runtimeAvailable: true
      })
    ).toBe(false)
  })

  it('selects the Codex, stored, and usable models.json providers from a mixed catalog', () => {
    expect(
      selectProjectedProviders(
        [
          { id: 'openai-codex' },
          { id: 'anthropic' },
          { id: 'athenai' },
          { id: 'keyless-gateway' },
          { id: 'custom-existing' }
        ],
        {
          stored: new Set(['custom-existing']),
          modelsJson: new Set(['athenai', 'keyless-gateway', 'custom-existing']),
          available: new Set(['athenai', 'anthropic'])
        }
      ).map((provider) => provider.id)
    ).toEqual(['openai-codex', 'athenai', 'custom-existing'])
  })
})
