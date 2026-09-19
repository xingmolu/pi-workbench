import { describe, expect, it } from 'vitest'
import {
  AgentRuntimeProviderRegistry,
  type AgentRuntime,
  type AgentRuntimeSessionOptions
} from './agent-runtime'

function runtime(id: 'pi' | 'claude-code' | 'codex'): AgentRuntime {
  return {
    provider: {
      id,
      label: id,
      hostCapabilities: true,
      residentSessions: true
    },
    async createSession(_options: AgentRuntimeSessionOptions) {
      throw new Error('not needed by registry test')
    }
  }
}

describe('AgentRuntimeProviderRegistry', () => {
  it('keeps agent runtime identity independent from model provider identity', () => {
    const registry = new AgentRuntimeProviderRegistry()
    registry.register(runtime('pi'))
    registry.register(runtime('claude-code'))
    registry.register(runtime('codex'))

    expect(registry.list().map((provider) => provider.id)).toEqual([
      'pi',
      'claude-code',
      'codex'
    ])
    expect(registry.get('claude-code').provider?.hostCapabilities).toBe(true)
  })

  it('rejects duplicate and missing providers', () => {
    const registry = new AgentRuntimeProviderRegistry()
    registry.register(runtime('pi'))
    expect(() => registry.register(runtime('pi'))).toThrow(/already registered/)
    expect(() => registry.get('codex')).toThrow(/not registered/)
    expect(() =>
      registry.register({
        async createSession(_options: AgentRuntimeSessionOptions) {
          throw new Error('unused')
        }
      })
    ).toThrow(/descriptor is required/)
  })
})
