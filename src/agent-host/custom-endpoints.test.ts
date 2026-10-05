import { describe, expect, it, vi } from 'vitest'
import { CustomEndpointService, type CustomEndpointDependencies } from './custom-endpoints'
import { SessionRuntimeUnsafeError } from './session-mutation-safety'
vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomUUID: () => '11111111-2222-4333-8444-555555555555'
}))

const endpoint = {
  label: 'Gateway',
  api: 'openai-completions' as const,
  baseUrl: 'https://gateway.example/v1',
  modelIds: ['m']
}
function fixture() {
  const state = {
    generation: 1,
    sessionId: 's',
    busy: false,
    promptPending: false,
    loginActive: false
  }
  const writes: unknown[] = []
  const removals: string[] = []
  const logouts: string[] = []
  let blocked = false
  const original = { provider: 'custom-existing', id: 'm', baseUrl: 'https://old.example' }
  const session = {
    model: original,
    thinkingLevel: 'off',
    sessionManager: { getLeafId: () => null, getEntries: () => [] },
    setModel: async (model: typeof original) => {
      session.model = model
    }
  }
  const snapshot = {
    revision: 'r',
    endpoints: [{ id: original.provider, ...endpoint, editable: true, unsupportedReason: null }]
  }
  const d: CustomEndpointDependencies<typeof original> = {
    config: {
      read: async () => snapshot,
      create: async (input) => {
        writes.push(input)
        return snapshot
      },
      update: async (input) => {
        writes.push(input)
        return snapshot
      },
      remove: async (input) => {
        removals.push(input.id)
        return { ...snapshot, endpoints: [] }
      }
    },
    runtime: {
      getProviders: () => [],
      getRegisteredProviderIds: () => [],
      getRegisteredNativeProvider: () => undefined,
      isUsingOAuth: () => false,
      getModel: () => ({ ...original, baseUrl: endpoint.baseUrl }),
      getError: () => undefined,
      refresh: async () => ({ errors: new Map(), aborted: false }),
      login: async () => {
        throw new Error('secret-fixture')
      },
      logout: async (id: string) => {
        logouts.push(id)
      }
    },
    readSafety: () => ({ ...state }),
    getSession: () => session,
    setSessionBlocked: (_target, value) => {
      blocked = value
    },
    rebuildProjections: async () => {}
  }
  return {
    d,
    state,
    writes,
    session,
    original,
    blocked: () => blocked,
    removals,
    logouts,
    request: { id: original.provider, expectedRevision: 'r', endpoint }
  }
}

describe('custom endpoint saves', () => {
  it('saves metadata and literal credential through offline runtime before publishing', async () => {
    const events: string[] = []
    let credential = ''
    const service = new CustomEndpointService({
      config: {
        read: async () => ({ revision: 'r1', endpoints: [] }),
        create: async () => {
          events.push('metadata')
          return { revision: 'r2', endpoints: [] }
        },
        update: async () => {
          throw new Error('unused')
        },
        remove: async () => {
          throw new Error('unused')
        }
      },
      runtime: {
        getProviders: () => [],
        getRegisteredProviderIds: () => [],
        getRegisteredNativeProvider: () => undefined,
        isUsingOAuth: () => false,
        getModel: () => undefined,
        getError: () => undefined,
        refresh: async (options) => {
          expect(options).toEqual({ allowNetwork: false })
          events.push('refresh')
          return { errors: new Map(), aborted: false }
        },
        login: async (_id, _type, interaction) => {
          credential = (await interaction.prompt({
            type: 'secret',
            message: 'Enter API key'
          })) as string
          events.push('credential')
          return { key: 'secret-return' }
        },
        logout: async () => {
          throw new Error('unused')
        }
      },
      readSafety: () => ({
        generation: 1,
        sessionId: null,
        busy: false,
        promptPending: false,
        loginActive: false
      }),
      rebuildProjections: async () => {
        events.push('publish')
      }
    })
    const result = await service.save({
      expectedRevision: 'r1',
      endpoint: {
        label: 'Gateway',
        api: 'openai-completions',
        baseUrl: 'https://gateway.example/v1',
        modelIds: ['m'],
        key: '!$ENV-秘密'
      }
    })
    expect(result).toMatchObject({
      ok: true,
      metadata: 'saved',
      credential: 'saved',
      runtime: 'synchronized'
    })
    expect(result.providerId).toMatch(/^custom-[0-9a-f-]{36}$/)
    expect(credential).toBe('$!$$ENV-秘密')
    expect(events).toEqual(['metadata', 'refresh', 'credential', 'refresh', 'publish'])
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('retains omitted credential and rebinds exactly the selected identity', async () => {
    const f = fixture()
    expect(await new CustomEndpointService(f.d).save(f.request)).toMatchObject({
      ok: true,
      credential: 'unchanged'
    })
    expect(f.session.model).not.toBe(f.original)
    expect(f.session.model).toEqual({ ...f.original, baseUrl: endpoint.baseUrl })
    expect(f.writes).toEqual([{ id: 'custom-existing', expectedRevision: 'r', endpoint }])
  })

  it.each(['busy', 'promptPending', 'loginActive'] as const)(
    'rejects %s before writes',
    async (field) => {
      const f = fixture()
      f.state[field] = true
      expect(await new CustomEndpointService(f.d).save(f.request)).toMatchObject({
        ok: false,
        metadata: 'unchanged'
      })
      expect(f.writes).toEqual([])
    }
  )

  it.each([
    'openai-codex',
    'openai-codex-alias',
    'anthropic',
    'custom-extension',
    'custom-native',
    'custom-oauth'
  ])('rejects protected %s', async (id) => {
    const f = fixture()
    f.d.runtime.getRegisteredProviderIds = () => ['custom-extension']
    f.d.runtime.getRegisteredNativeProvider = (value) => value === 'custom-native'
    f.d.runtime.isUsingOAuth = (value) => value === 'custom-oauth'
    expect(await new CustomEndpointService(f.d).save({ ...f.request, id })).toMatchObject({
      ok: false,
      metadata: 'unchanged'
    })
    expect(f.writes).toEqual([])
  })

  it.each(['', '   '])('rejects empty key without deleting saved credentials', async (key) => {
    const f = fixture()
    expect(
      await new CustomEndpointService(f.d).save({ ...f.request, endpoint: { ...endpoint, key } })
    ).toMatchObject({ metadata: 'unchanged', credential: 'unchanged' })
    expect(f.writes).toEqual([])
  })

  it('requires explicit placeholder credential for a new local endpoint', async () => {
    const f = fixture()
    expect(
      await new CustomEndpointService(f.d).save({
        expectedRevision: 'r',
        endpoint: { ...endpoint, baseUrl: 'http://localhost:1234' }
      })
    ).toMatchObject({ ok: false, metadata: 'unchanged' })
  })

  it.each([
    'read',
    'update',
    'refresh',
    'error',
    'aborted',
    'projection',
    'login',
    'second-refresh'
  ] as const)('reports truthful sanitized state when %s fails', async (failure) => {
    const f = fixture()
    const throwing = async () => {
      throw new Error('secret-fixture headers full-config')
    }
    if (failure === 'read' || failure === 'update') f.d.config[failure] = throwing
    if (failure === 'refresh') f.d.runtime.refresh = throwing
    if (failure === 'error') f.d.runtime.getError = () => 'secret-fixture'
    if (failure === 'aborted')
      f.d.runtime.refresh = async () => ({ aborted: true, errors: new Map() })
    if (failure === 'projection') f.d.rebuildProjections = throwing
    if (failure === 'second-refresh') {
      let count = 0
      f.d.runtime.refresh = async () => {
        if (++count === 2) throw new Error('secret-fixture')
        return { aborted: false, errors: new Map() }
      }
    }
    f.d.runtime.login = failure === 'login' ? throwing : async () => ({ key: 'secret-fixture' })
    const result = await new CustomEndpointService(f.d).save({
      ...f.request,
      endpoint: { ...endpoint, key: 'secret-fixture' }
    })
    expect(result.ok).toBe(false)
    expect(result.metadata).toBe(['read', 'update'].includes(failure) ? 'unchanged' : 'saved')
    expect(result.credential).toBe(
      failure === 'login'
        ? 'unknown'
        : ['second-refresh', 'projection'].includes(failure)
          ? 'saved'
          : 'unchanged'
    )
    expect(JSON.stringify(result)).not.toMatch(/secret-fixture|headers|full-config/)
    expect(f.session.model).toBe(f.original)
  })

  it.each(['prompt', 'notify'])(
    'refuses unexpected login %s without answering secrets',
    async (type) => {
      const f = fixture()
      f.d.runtime.login = async (_id, _type, interaction) => {
        if (type === 'notify') interaction.notify({ type: 'info', message: 'secret-fixture' })
        else await interaction.prompt({ type: 'secret', message: 'secret-fixture' })
      }
      const result = await new CustomEndpointService(f.d).save({
        ...f.request,
        endpoint: { ...endpoint, key: 'secret-fixture' }
      })
      expect(result).toMatchObject({ ok: false, metadata: 'saved', credential: 'unknown' })
      expect(JSON.stringify(result)).not.toContain('secret-fixture')
    }
  )

  it('blocks deleted selected model without changing history or selecting a fallback', async () => {
    const f = fixture()
    f.d.runtime.getModel = () => undefined
    expect(await new CustomEndpointService(f.d).save(f.request)).toMatchObject({ ok: true })
    expect(f.blocked()).toBe(true)
    expect(f.session.model).toBe(f.original)
  })

  it.each(['read', 'write', 'refresh', 'login', 'projection'])(
    'does not mutate a switched session after %s',
    async (step) => {
      const f = fixture()
      const switchSession = () => {
        f.state.generation++
        f.state.sessionId = 'new'
      }
      if (step === 'read') {
        const read = f.d.config.read
        f.d.config.read = async () => {
          const result = await read()
          switchSession()
          return result
        }
      }
      if (step === 'write') {
        const write = f.d.config.update
        f.d.config.update = async (input) => {
          const result = await write(input)
          switchSession()
          return result
        }
      }
      if (step === 'refresh')
        f.d.runtime.refresh = async () => {
          switchSession()
          return { aborted: false, errors: new Map() }
        }
      if (step === 'login')
        f.d.runtime.login = async () => {
          switchSession()
        }
      if (step === 'projection') {
        f.d.runtime.login = async () => {}
        f.d.rebuildProjections = async () => {
          switchSession()
        }
      }
      const result = await new CustomEndpointService(f.d).save({
        ...f.request,
        endpoint: { ...endpoint, key: 'secret-fixture' }
      })
      expect(result.ok).toBe(false)
      expect(f.session.model).toBe(f.original)
      expect(f.blocked()).toBe(false)
    }
  )

  it('propagates fatal partially mutated session to the host outer guard', async () => {
    const f = fixture()
    f.session.setModel = async (model) => {
      f.session.model = model
      throw new Error('secret-fixture')
    }
    await expect(new CustomEndpointService(f.d).save(f.request)).rejects.toBeInstanceOf(
      SessionRuntimeUnsafeError
    )
  })

  it('does not claim credential saved if a provider swallowed an unexpected interaction failure', async () => {
    const f = fixture()
    f.d.runtime.login = async (_id, _type, interaction) => {
      try {
        interaction.notify({ type: 'info', message: 'secret-fixture' })
      } catch {}
      return { key: 'secret-fixture' }
    }
    expect(
      await new CustomEndpointService(f.d).save({
        ...f.request,
        endpoint: { ...endpoint, key: 'secret-fixture' }
      })
    ).toMatchObject({ ok: false, credential: 'unknown' })
  })

  it.each([true, false])(
    'saving B invalidates externally changed A only when config differs (%s)',
    async (changed) => {
      const f = fixture()
      f.session.model = { ...f.original, provider: 'other-provider' }
      f.d.runtime.getModel = () => ({
        ...f.session.model,
        baseUrl: changed ? 'https://external.example' : f.session.model.baseUrl
      })
      const reasons: string[] = []
      f.d.invalidateSelection = (_target, reason) => {
        reasons.push(reason)
      }
      f.session.setModel = async () => {
        throw new Error('other provider must not rebind')
      }
      const result = await new CustomEndpointService(f.d).save(f.request)
      expect(result.ok).toBe(true)
      expect(reasons).toEqual(changed ? ['model-config-changed'] : [])
      expect(result.selection).toBe(changed ? 'model-config-changed' : 'unchanged')
    }
  )

  it.each(['runtime', 'file'])('rejects generated identity collision in %s', async (source) => {
    const f = fixture()
    const id = 'custom-11111111-2222-4333-8444-555555555555'
    if (source === 'runtime') f.d.runtime.getProviders = () => [{ id }]
    else
      f.d.config.read = async () => ({
        revision: 'r',
        endpoints: [{ id, ...endpoint, editable: true, unsupportedReason: null }]
      })
    expect(
      await new CustomEndpointService(f.d).save({
        expectedRevision: 'r',
        endpoint: { ...endpoint, key: 'placeholder' }
      })
    ).toMatchObject({ ok: false, metadata: 'unchanged' })
    expect(f.writes).toEqual([])
  })

  it('serializes saves and rejects a queued request after its session changes', async () => {
    const f = fixture()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const read = f.d.config.read
    let reads = 0
    f.d.config.read = async () => {
      if (++reads === 1) await pending
      return read()
    }
    const service = new CustomEndpointService(f.d)
    const first = service.save(f.request)
    const second = service.save(f.request)
    await Promise.resolve()
    expect(reads).toBe(1)
    f.state.generation++
    release()
    expect((await first).ok).toBe(false)
    expect((await second).ok).toBe(false)
    expect(f.writes).toEqual([])
  })

  it('fails closed for refresh error maps and recoverable setter failures', async () => {
    const f = fixture()
    f.d.runtime.refresh = async () => ({
      aborted: false,
      errors: new Map([['provider', new Error('secret-fixture')]])
    })
    expect(await new CustomEndpointService(f.d).save(f.request)).toMatchObject({
      metadata: 'saved',
      runtime: 'failed'
    })
    f.d.runtime.refresh = async () => ({ aborted: false, errors: new Map() })
    f.session.setModel = async () => {
      throw new Error('secret-fixture')
    }
    const result = await new CustomEndpointService(f.d).save(f.request)
    expect(result).toMatchObject({ ok: false, metadata: 'saved', runtime: 'failed' })
    expect(JSON.stringify(result)).not.toContain('secret-fixture')
    expect(f.blocked()).toBe(true)
  })

  it('rechecks newly registered protection after the config read', async () => {
    const f = fixture()
    const read = f.d.config.read
    f.d.config.read = async () => {
      const snapshot = await read()
      f.d.runtime.getRegisteredProviderIds = () => ['custom-existing']
      return snapshot
    }
    expect(await new CustomEndpointService(f.d).save(f.request)).toMatchObject({
      ok: false,
      metadata: 'unchanged'
    })
    expect(f.writes).toEqual([])
  })

  it('never invalidates unrelated provider in a newly switched session', async () => {
    const f = fixture()
    f.session.model = { ...f.original, provider: 'other-provider' }
    f.d.rebuildProjections = async () => {
      f.state.generation++
    }
    const reasons: string[] = []
    f.d.invalidateSelection = (_target, reason) => {
      reasons.push(reason)
    }
    expect(await new CustomEndpointService(f.d).save(f.request)).toMatchObject({ ok: false })
    expect(reasons).toEqual([])
  })

  it('invalidates unrelated selected model if private catalog comparison fails', async () => {
    const f = fixture()
    f.session.model = { ...f.original, provider: 'other-provider' }
    f.d.runtime.getModel = () =>
      new Proxy(
        { ...f.session.model },
        {
          ownKeys: () => {
            throw new Error('secret-fixture')
          }
        }
      )
    const reasons: string[] = []
    f.d.invalidateSelection = (_target, reason) => {
      reasons.push(reason)
    }
    const result = await new CustomEndpointService(f.d).save(f.request)
    expect(reasons).toEqual(['model-config-changed'])
    expect(JSON.stringify(result)).not.toContain('secret-fixture')
  })

  it('blocks the captured unrelated provider session when a full refresh fails', async () => {
    const f = fixture()
    f.session.model = { ...f.original, provider: 'other-provider' }
    f.d.runtime.refresh = async () => {
      throw new Error('secret-fixture')
    }
    expect(await new CustomEndpointService(f.d).save(f.request)).toMatchObject({
      metadata: 'saved',
      runtime: 'failed'
    })
    expect(f.blocked()).toBe(true)
  })

  it('never releases a key after an unexpected notification was swallowed', async () => {
    const f = fixture()
    let delivered = false
    f.d.runtime.login = async (_id, _type, interaction) => {
      try {
        interaction.notify({ type: 'info', message: 'secret-fixture' })
      } catch {}
      try {
        await interaction.prompt({ type: 'secret', message: 'Enter API key' })
        delivered = true
      } catch {}
    }
    expect(
      await new CustomEndpointService(f.d).save({
        ...f.request,
        endpoint: { ...endpoint, key: 'secret-fixture' }
      })
    ).toMatchObject({ ok: false, credential: 'unknown' })
    expect(delivered).toBe(false)
  })

  it.each(['busy', 'promptPending', 'loginActive'] as const)(
    'latches failure blocking when the same session becomes %s after metadata save',
    async (flag) => {
      const f = fixture()
      f.d.runtime.refresh = async () => {
        f.state[flag] = true
        return { aborted: false, errors: new Map() }
      }
      expect(await new CustomEndpointService(f.d).save(f.request)).toMatchObject({
        ok: false,
        metadata: 'saved',
        runtime: 'failed'
      })
      expect(f.blocked()).toBe(true)
      expect(f.session.model).toBe(f.original)
    }
  )

  it('does not latch failure blocking on a replacement session that is busy', async () => {
    const f = fixture()
    f.d.runtime.refresh = async () => {
      f.state.generation++
      f.state.busy = true
      return { aborted: false, errors: new Map() }
    }
    expect(await new CustomEndpointService(f.d).save(f.request)).toMatchObject({
      ok: false,
      metadata: 'saved',
      runtime: 'failed'
    })
    expect(f.blocked()).toBe(false)
  })

  it('keeps captured identity immutable when readSafety returns a live object', async () => {
    const f = fixture()
    f.d.readSafety = () => f.state
    f.d.runtime.refresh = async () => {
      f.state.sessionId = 'replacement-session'
      f.state.generation++
      return { aborted: false, errors: new Map() }
    }
    const result = await new CustomEndpointService(f.d).save(f.request)
    expect(result).toMatchObject({ ok: false, metadata: 'saved', runtime: 'failed' })
    expect(f.session.model).toBe(f.original)
    expect(f.blocked()).toBe(false)
  })
})

describe('custom endpoint removal', () => {
  it('deletes the entry and its credential and asks a session using it to choose again', async () => {
    const f = fixture()
    const result = await new CustomEndpointService(f.d).remove({
      id: f.original.provider,
      expectedRevision: 'r'
    })
    expect(result).toMatchObject({
      ok: true,
      metadata: 'saved',
      credential: 'saved',
      runtime: 'synchronized',
      selection: 'model-missing'
    })
    expect(f.removals).toEqual([f.original.provider])
    expect(f.logouts).toEqual([f.original.provider])
    expect(f.blocked()).toBe(true)
  })

  it('refuses while the session is busy and writes nothing', async () => {
    const f = fixture()
    f.state.busy = true
    const result = await new CustomEndpointService(f.d).remove({
      id: f.original.provider,
      expectedRevision: 'r'
    })
    expect(result).toMatchObject({ ok: false, metadata: 'unchanged' })
    expect(f.removals).toEqual([])
    expect(f.logouts).toEqual([])
  })
})
