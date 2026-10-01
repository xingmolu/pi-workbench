import { describe, expect, it } from 'vitest'
import {
  agentStatePatchSchema,
  browserCommandSchema,
  browserEventSchema,
  hostCommandSchema,
  hostResultSchema,
  hostRequestSchema
} from './schemas'
import { BROWSER_VIEW_ID } from './workbench-contracts'
import { workbenchEventSchema } from './workbench-schemas'

it('accepts native identity only on the strict Main-to-Host envelope', () => {
  const command = { type: 'prompt:abort' }
  const expectedIdentity = { sessionId: 'source', generation: 2 }
  expect(hostCommandSchema.safeParse({ ...command, expectedIdentity }).success).toBe(false)
  expect(hostRequestSchema.safeParse({ ...command, expectedIdentity, requestId: 'request' }).success).toBe(true)
  expect(hostRequestSchema.safeParse({ ...command, expectedIdentity: { ...expectedIdentity, generation: -1 }, requestId: 'request' }).success).toBe(false)
})

it('requires canonical scoped fork and prompt inputs and rejects extra path authority', () => {
  const fork = { type: 'session:fork', sessionId: 'source', generation: 1, entryId: 'leaf' }
  expect(hostCommandSchema.safeParse(fork).success).toBe(true)
  for (const invalid of [
    { ...fork, path: '/arbitrary' },
    { ...fork, entryId: '' },
    { ...fork, generation: -1 },
    { type: 'session:fork', sessionId: 'source', entryId: 'leaf' },
    { type: 'prompt:send', text: 'hello' }
  ])
    expect(hostCommandSchema.safeParse(invalid).success).toBe(false)
  expect(hostRequestSchema.safeParse({ ...fork, requestId: 'request' }).success).toBe(true)
  expect(
    hostCommandSchema.safeParse({
      type: 'prompt:send',
      text: 'hello',
      sessionId: 'source',
      generation: 1
    }).success
  ).toBe(true)
})

describe('browser opaque ref input', () => {
  it('rejects over-budget wait text instead of silently waiting for a shortened prefix', () => {
    expect(
      browserCommandSchema.safeParse({
        type: 'operate',
        operation: { action: 'wait', text: 'x'.repeat(10001) }
      }).success
    ).toBe(false)
  })
  it('rejects legacy, fake and oversized refs on the public command boundary', () => {
    for (const ref of ['@e1', '#one', '------------------------------------:1', 'x'.repeat(1000)])
      expect(
        browserCommandSchema.safeParse({ type: 'operate', operation: { action: 'click', ref } })
          .success
      ).toBe(false)
    expect(
      browserCommandSchema.safeParse({
        type: 'operate',
        operation: {
          action: 'fill',
          ref: 'a346309f-07bc-4c76-8046-ea0a938dcd97:1',
          value: 'x'.repeat(10001)
        }
      }).success
    ).toBe(false)
  })
})

describe('custom endpoint IPC envelopes', () => {
  const command = {
    type: 'endpoint:save',
    context: { projectPath: null, sessionId: null, generation: 0 },
    request: {
      expectedRevision: 'revision',
      endpoint: {
        label: 'fixture',
        api: 'openai-completions',
        baseUrl: 'https://example.invalid',
        modelIds: ['a'],
        key: 'fixture-secret'
      }
    }
  }
  const result = {
    kind: 'endpoint-save',
    result: {
      ok: true,
      providerId: 'custom-fixture',
      metadata: 'saved',
      credential: 'saved',
      runtime: 'synchronized',
      selection: 'unchanged',
      message: '端点已保存',
      snapshot: { revision: 'revision', endpoints: [] }
    }
  }
  it('accepts list and save commands, request IDs, and their distinct result envelopes', () => {
    expect(hostCommandSchema.safeParse({ type: 'endpoint:list' }).success).toBe(true)
    expect(hostCommandSchema.safeParse(command).success).toBe(true)
    expect(hostRequestSchema.safeParse({ ...command, requestId: 'request' }).success).toBe(true)
    expect(
      hostRequestSchema.safeParse({ type: 'endpoint:list', requestId: 'request' }).success
    ).toBe(true)
    expect(
      hostResultSchema.safeParse({
        kind: 'endpoint-list',
        snapshot: { revision: 'r', endpoints: [] },
        configPath: '/fixture/models.json'
      }).success
    ).toBe(true)
    expect(hostResultSchema.safeParse(result).success).toBe(true)
  })
  it('rejects malformed context and undeclared command/request fields', () => {
    for (const context of [
      { ...command.context, generation: -1 },
      { ...command.context, generation: 0.5 },
      { sessionId: null, generation: 0 },
      { ...command.context, sessionId: 4 },
      { ...command.context, key: 'leak' }
    ])
      expect(hostCommandSchema.safeParse({ ...command, context }).success).toBe(false)
    expect(hostCommandSchema.safeParse({ ...command, rawConfig: {} }).success).toBe(false)
    expect(hostRequestSchema.safeParse({ ...command, requestId: 'r', key: 'leak' }).success).toBe(
      false
    )
    expect(
      hostCommandSchema.safeParse({
        ...command,
        request: {
          ...command.request,
          endpoint: { ...command.request.endpoint, headers: { Authorization: 'leak' } }
        }
      }).success
    ).toBe(false)
  })
  it('rejects credentials and raw config anywhere outside the save input', () => {
    for (const extra of [{ key: 'leak' }, { rawConfig: { providers: {} } }]) {
      expect(hostResultSchema.safeParse({ ...result, ...extra }).success).toBe(false)
      expect(
        hostResultSchema.safeParse({ ...result, result: { ...result.result, ...extra } }).success
      ).toBe(false)
      expect(
        hostResultSchema.safeParse({
          kind: 'endpoint-list',
          configPath: '/fixture/models.json',
          snapshot: { revision: 'r', endpoints: [], ...extra }
        }).success
      ).toBe(false)
    }
  })
})

describe('canonical history metadata schemas', () => {
  const parseNode = (node: unknown) =>
    agentStatePatchSchema.safeParse({
      sessionId: 's',
      generation: 1,
      baseRevision: 0,
      revision: 1,
      nodeUpserts: [node],
      removedNodeIds: [],
      meta: {}
    }).success
  it('accepts actual model and compaction facts', () => {
    expect(parseNode({ id: 'm', type: 'model', provider: 'p', modelId: 'm', initial: true })).toBe(
      true
    )
    expect(
      parseNode({
        id: 'm',
        type: 'model',
        provider: 'p',
        modelId: 'm',
        name: 'Model',
        initial: false
      })
    ).toBe(true)
    expect(parseNode({ id: 'c', type: 'compaction', tokensBefore: 12000 })).toBe(true)
  })
  it('accepts bounded optional presentation identity but rejects malformed or undeclared fields', () => {
    const node = { id: 'entry:a:think:0', type: 'think', text: 'thought' }
    expect(parseNode(node)).toBe(true)
    expect(parseNode({ ...node, presentationIdentity: 'presentation:1-2:think:0' })).toBe(true)
    expect(parseNode({ ...node, presentationIdentity: 'p'.repeat(1024) })).toBe(true)
    for (const presentationIdentity of ['', 'p'.repeat(1025), 1, null])
      expect(parseNode({ ...node, presentationIdentity })).toBe(false)
    expect(parseNode({ ...node, presentationIdentity: 'p', privatePayload: 'secret' })).toBe(false)
  })
  it('rejects missing identities, invalid counts and undeclared metadata', () => {
    expect(parseNode({ id: 'm', type: 'model', modelId: 'm', initial: true })).toBe(false)
    expect(
      parseNode({
        id: 'm',
        type: 'model',
        provider: 'p',
        modelId: 'm',
        initial: true,
        apiKey: 'secret'
      })
    ).toBe(false)
    expect(parseNode({ id: 'c', type: 'compaction', tokensBefore: -1 })).toBe(false)
    expect(parseNode({ id: 'c', type: 'compaction', tokensBefore: 1.5 })).toBe(false)
    expect(
      parseNode({ id: 'c', type: 'compaction', tokensBefore: 12, summary: 'private summary' })
    ).toBe(false)
  })
})

describe('session:rename schema', () => {
  const command = {
    type: 'session:rename',
    sessionId: 'session-1',
    generation: 4,
    name: ' 新名字 😀 '
  }

  it('accepts the command and strict request envelope', () => {
    expect(hostCommandSchema.safeParse(command).success).toBe(true)
    expect(hostRequestSchema.safeParse({ ...command, requestId: 'rename-1' }).success).toBe(true)
  })

  it.each([
    { sessionId: '' },
    { sessionId: null },
    { sessionId: undefined },
    { generation: -1 },
    { generation: 1.5 },
    { generation: '4' },
    { generation: undefined },
    { name: '' },
    { name: ' ' },
    { name: '\nname' },
    { name: 'a\u2028b' },
    { name: '😀'.repeat(81) },
    { name: 7 },
    { name: undefined },
    { extra: true }
  ])('rejects malformed command and request fields %j', (override) => {
    expect(hostCommandSchema.safeParse({ ...command, ...override }).success).toBe(false)
    expect(
      hostRequestSchema.safeParse({ ...command, ...override, requestId: 'rename-1' }).success
    ).toBe(false)
  })
})

describe('queue:clear schema', () => {
  it('accepts the typed command and request', () => {
    expect(hostCommandSchema.parse({ type: 'queue:clear' })).toEqual({ type: 'queue:clear' })
    expect(hostRequestSchema.parse({ type: 'queue:clear', requestId: 'request-1' })).toEqual({
      type: 'queue:clear',
      requestId: 'request-1'
    })
  })

  it('rejects untyped queue payloads', () => {
    expect(hostCommandSchema.safeParse({ type: 'queue:clear', index: 0 }).success).toBe(false)
  })
})

describe('browser and Workbench event ownership', () => {
  it('keeps Browser events state-only and routes reveal through Workbench', () => {
    expect(browserEventSchema.safeParse({ type: 'agent-open' }).success).toBe(false)
    expect(
      workbenchEventSchema.parse({
        type: 'reveal',
        viewId: BROWSER_VIEW_ID
      })
    ).toEqual({ type: 'reveal', viewId: BROWSER_VIEW_ID })
  })

  it('keeps native view placement on the Workbench command surface', () => {
    expect(
      browserCommandSchema.safeParse({
        type: 'view:set',
        visible: true,
        bounds: { x: 0, y: 0, width: 320, height: 480 }
      }).success
    ).toBe(false)
  })
})

it('accepts image prompts only with supported types, valid base64 and at most four images', () => {
  const base = { type: 'prompt:send', text: '', sessionId: 's', generation: 1 }
  const image = { mimeType: 'image/jpeg', data: 'aGVsbG8=' }
  expect(hostCommandSchema.safeParse({ ...base, images: [image] }).success).toBe(true)
  expect(hostCommandSchema.safeParse({ ...base, text: 'hi' }).success).toBe(true)
  expect(
    hostCommandSchema.safeParse({ ...base, images: [{ ...image, mimeType: 'image/svg+xml' }] })
      .success
  ).toBe(false)
  expect(
    hostCommandSchema.safeParse({ ...base, images: [{ ...image, data: 'not base64!' }] }).success
  ).toBe(false)
  expect(hostCommandSchema.safeParse({ ...base, images: Array(5).fill(image) }).success).toBe(
    false
  )
  expect(hostCommandSchema.safeParse({ ...base, images: [] }).success).toBe(false)
})

it('keeps API keys off plain HTTP except on this machine', () => {
  const command = { type: 'account:api-key:set', providerId: 'new', apiKey: 'k' }
  const accepts = (baseUrl: string): boolean =>
    hostCommandSchema.safeParse({ ...command, baseUrl }).success
  expect(accepts('https://llm.example.com')).toBe(true)
  expect(accepts('http://localhost:8080')).toBe(true)
  expect(accepts('http://llm.example.com')).toBe(false)
  expect(accepts('javascript:alert(1)')).toBe(false)
})
