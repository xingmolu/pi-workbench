import * as fs from 'node:fs/promises'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CustomEndpointConfig, type CustomEndpointConfigIo } from './custom-endpoint-config'

const fixtures: string[] = []
async function fixture(text?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-custom-endpoint-'))
  fixtures.push(dir)
  const file = join(dir, 'models.json')
  if (text !== undefined) await writeFile(file, text)
  return { dir, file, config: new CustomEndpointConfig(file) }
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const endpoint = {
  label: 'Gateway',
  api: 'openai-completions' as const,
  baseUrl: 'https://example.com/v1',
  modelIds: ['model-a']
}
const provider = {
  name: endpoint.label,
  api: endpoint.api,
  baseUrl: endpoint.baseUrl,
  models: [{ id: 'model-a' }]
}
const document = (value: unknown) => JSON.stringify({ providers: { 'custom-fixture': value } })

describe('custom endpoint config', () => {
  it('creates canonical metadata without persisting credentials or losing unrelated text', async () => {
    const { file, config } = await fixture(
      '\uFEFF{\r\n  // keep this\r\n  "other": true,\r\n  "providers": {"existing": {"apiKey": "fixture-secret"}}\r\n}\r\n'
    )
    const before = await config.read()
    const saved = await config.create({
      id: 'custom-fixture',
      expectedRevision: before.revision,
      endpoint
    })
    const bytes = await readFile(file, 'utf8')
    expect(bytes.startsWith('\uFEFF')).toBe(true)
    expect(bytes).toContain('// keep this\r\n')
    expect(bytes).toContain('"existing": {"apiKey": "fixture-secret"}')
    expect(bytes).toContain('"other": true')
    expect(saved.revision).not.toBe(before.revision)
    expect(saved.endpoints.find((item) => item.id === 'custom-fixture')).toEqual({
      id: 'custom-fixture',
      ...endpoint,
      imageModelIds: [],
      editable: true,
      unsupportedReason: null
    })
    expect(JSON.stringify(saved)).not.toContain('fixture-secret')
  })

  it('reads image-capable models and creates mixed model input declarations', async () => {
    const { file, config } = await fixture(
      document({
        ...provider,
        models: [{ id: 'model-a', input: ['text', 'image'] }, { id: 'model-b' }]
      })
    )
    const before = await config.read()
    expect(before.endpoints[0]).toMatchObject({
      editable: true,
      modelIds: ['model-a', 'model-b'],
      imageModelIds: ['model-a']
    })
    const saved = await config.create({
      id: 'custom-other',
      expectedRevision: before.revision,
      endpoint: { ...endpoint, modelIds: ['text-only', 'vision'], imageModelIds: ['vision'] }
    })
    expect(saved.endpoints.find((item) => item.id === 'custom-other')?.imageModelIds).toEqual([
      'vision'
    ])
    expect(JSON.parse(await readFile(file, 'utf8')).providers['custom-other'].models).toEqual([
      { id: 'text-only' },
      { id: 'vision', input: ['text', 'image'] }
    ])
  })

  it('turns image input off with a targeted edit while retaining model details and comments', async () => {
    const source = `{ "providers": { "custom-fixture": { "name":"Gateway", "api":"openai-completions", "baseUrl":"https://example.com/v1", "models": [ { "id":"model-a", /* keep */ "name":"A", "input":["text","image"], "contextWindow":1234 } ] } } }`
    const { file, config } = await fixture(source)
    const before = await config.read()
    await config.update({
      id: 'custom-fixture',
      expectedRevision: before.revision,
      endpoint: { ...endpoint, imageModelIds: [] }
    })
    const bytes = await readFile(file, 'utf8')
    expect(bytes).toContain('/* keep */ "name":"A"')
    expect(bytes).toContain('"contextWindow":1234')
    expect(
      JSON.parse(bytes.replace(/\/\* keep \*\//, '')).providers['custom-fixture'].models[0].input
    ).toEqual(['text'])
  })

  it('preserves image input when an older caller omits imageModelIds', async () => {
    const source = document({ ...provider, models: [{ id: 'model-a', input: ['text', 'image'] }] })
    const { file, config } = await fixture(source)
    const before = await config.read()
    const saved = await config.update({
      id: 'custom-fixture',
      expectedRevision: before.revision,
      endpoint: { ...endpoint, label: 'Renamed' }
    })
    expect(saved.endpoints[0].imageModelIds).toEqual(['model-a'])
    expect(
      JSON.parse(await readFile(file, 'utf8')).providers['custom-fixture'].models[0].input
    ).toEqual(['text', 'image'])
  })

  it.each([['image'], ['text', 'image', 'audio'], 'text', null, []])(
    'treats unsupported input shape as read-only (%#)',
    async (input) => {
      const source = document({ ...provider, models: [{ id: 'model-a', input }] })
      const { file, config } = await fixture(source)
      const before = await config.read()
      expect(before.endpoints[0].editable).toBe(false)
      await expect(
        config.update({ id: 'custom-fixture', expectedRevision: before.revision, endpoint })
      ).rejects.toMatchObject({ code: 'read-only' })
      expect(await readFile(file, 'utf8')).toBe(source)
    }
  )

  it('preserves surviving model details and comments and removes only explicitly removed IDs', async () => {
    const source = `{ "extra": {"__proto__": {"preserved": true}}, "providers": {
      "__proto__": {"unrelated": true}, "constructor": {"untouched": true},
      "custom-fixture": {"name":"Old", "api":"openai-completions", "baseUrl":"https://example.com/v1", "customDetail":42,
        "models":[ {"id":"model-a", /* model comment */ "name":"A", "contextWindow":1234, "__proto__":{"kept":true}}, {"id":"removed"} ]}
    } }\n`
    const { file, config } = await fixture(source)
    const before = await config.read()
    await config.update({
      id: 'custom-fixture',
      expectedRevision: before.revision,
      endpoint: {
        ...endpoint,
        label: 'New',
        api: 'anthropic-messages',
        modelIds: ['model-a', 'new']
      }
    })
    const bytes = await readFile(file, 'utf8')
    expect(bytes).toContain(
      '{"id":"model-a", /* model comment */ "name":"A", "contextWindow":1234, "__proto__":{"kept":true}}'
    )
    expect(bytes).toContain('"__proto__": {"unrelated": true}, "constructor": {"untouched": true}')
    expect(bytes).toContain('"extra": {"__proto__": {"preserved": true}}')
    expect(bytes).toContain('"customDetail":42')
    expect(bytes).not.toContain('"removed"')
    expect(
      (await config.read()).endpoints.find((item) => item.id === 'custom-fixture')
    ).toMatchObject({ label: 'New', api: 'anthropic-messages', modelIds: ['model-a', 'new'] })
    expect(Reflect.get({}, 'preserved')).toBeUndefined()
  })

  it.each([
    '',
    '{',
    '{"providers":{},}',
    '{"providers":{},"providers":{}}',
    '{"providers":{"custom-fixture":{"models":[],"models":[]}}}',
    '{"providers":{"custom-fixture":{"models":[{"id":"a","\\u0069d":"b"}]}}}',
    '[]',
    'null',
    '{"providers":null}',
    '{"providers":[]}',
    '{"providers":{"bad":null}}',
    '{"providers":{"bad":[]}}',
    '{"deep":' + '['.repeat(32) + '0' + ']'.repeat(32) + '}',
    '{"providers":' +
      JSON.stringify(Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`p${i}`, {}]))) +
      '}',
    ' '.repeat(1024 * 1024 + 1)
  ])('rejects malformed or unbounded config without replacement (%#)', async (source) => {
    const { file, config } = await fixture(source)
    await expect(config.read()).rejects.toMatchObject({ code: 'invalid-config' })
    await expect(
      config.create({ id: 'custom-new', expectedRevision: 'missing', endpoint })
    ).rejects.toMatchObject({ code: 'invalid-config' })
    expect(await readFile(file, 'utf8')).toBe(source)
  })

  it('accepts exactly the depth and byte limits, counting only structural tokens', async () => {
    const valid =
      '{"text":"[[[", "comment": /* {{{ */' + '['.repeat(31) + '0' + ']'.repeat(31) + '}'
    const { config } = await fixture(valid.padEnd(1024 * 1024, ' '))
    expect((await config.read()).endpoints).toEqual([])
  })

  it.each([
    '{}'.padEnd(1024 * 1024, ' '),
    JSON.stringify({
      providers: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`p${i}`, {}]))
    })
  ])('refuses a write that would exceed file or provider limits (%#)', async (source) => {
    const { file, config } = await fixture(source)
    const before = await config.read()
    await expect(
      config.create({ id: 'custom-new', expectedRevision: before.revision, endpoint })
    ).rejects.toMatchObject({ code: 'invalid-config' })
    expect(await readFile(file, 'utf8')).toBe(source)
  })

  it.each([
    { key: 'fixture-secret' },
    { apiKey: 'fixture-secret' },
    { headers: { Authorization: 'fixture-secret' } },
    { modelOverrides: {} },
    { auth: true },
    { authHeader: true },
    { oauth: 'radius' },
    { api: 'fixture-secret' },
    { baseUrl: 'https://user:fixture-secret@example.com?key=fixture-secret' },
    { models: [{ id: 'model-a', api: 'anthropic-messages' }] },
    { models: [{ id: 'model-a', baseUrl: 'https://fixture-secret.example.com' }] },
    { models: [{ id: 'model-a', headers: { fixture: 'fixture-secret' } }] },
    { models: [{ id: 'model-a', apiKey: 'fixture-secret' }] },
    { models: [{ id: 'model-a', authHeader: true }] },
    { models: [{ id: 'model-a' }, { id: 'model-a' }] },
    { models: [{ id: ' model-a ' }] }
  ])('projects advanced configurations as sanitized read-only metadata (%#)', async (patch) => {
    const source = document({ ...provider, ...patch })
    const { file, config } = await fixture(source)
    const before = await config.read()
    expect(before.endpoints[0].editable).toBe(false)
    expect(before.endpoints[0].unsupportedReason).toBe(
      '此配置包含不支持的字段或地址，请在 Pi 配置文件中管理'
    )
    expect(Object.keys(before.endpoints[0]).sort()).toEqual([
      'api',
      'baseUrl',
      'editable',
      'id',
      'imageModelIds',
      'label',
      'modelIds',
      'unsupportedReason'
    ])
    expect(JSON.stringify(before)).not.toContain('fixture-secret')
    await expect(
      config.update({ id: 'custom-fixture', expectedRevision: before.revision, endpoint })
    ).rejects.toMatchObject({ code: 'read-only' })
    expect(await readFile(file, 'utf8')).toBe(source)
  })

  it('rejects collisions, reserved identities and protected runtime providers', async () => {
    const { file, config } = await fixture(document(provider))
    const before = await config.read()
    await expect(
      config.create({ id: 'custom-fixture', expectedRevision: before.revision, endpoint })
    ).rejects.toMatchObject({ code: 'collision' })
    for (const id of [
      'openai-codex',
      'openai-codex-alias',
      'anthropic',
      '__proto__',
      'constructor'
    ]) {
      await expect(
        config.create({ id, expectedRevision: before.revision, endpoint })
      ).rejects.toMatchObject({ code: 'invalid-input' })
    }
    const protectedConfig = new CustomEndpointConfig(file, {
      protectedProviderIds: ['custom-fixture', 'custom-runtime']
    })
    expect((await protectedConfig.read()).endpoints[0].editable).toBe(false)
    await expect(
      protectedConfig.update({ id: 'custom-fixture', expectedRevision: before.revision, endpoint })
    ).rejects.toMatchObject({ code: 'read-only' })
    await expect(
      protectedConfig.create({ id: 'custom-runtime', expectedRevision: before.revision, endpoint })
    ).rejects.toMatchObject({ code: 'read-only' })
  })

  it('revalidates metadata without accepting credential or advanced fields for disk writes', async () => {
    const { file, config } = await fixture('{}')
    const before = await config.read()
    await expect(
      config.create({
        id: 'custom-new',
        expectedRevision: before.revision,
        endpoint: { ...endpoint, key: 'fixture-secret' } as typeof endpoint
      })
    ).rejects.toMatchObject({ code: 'invalid-input' })
    expect(await readFile(file, 'utf8')).toBe('{}')
  })

  it('rejects invalid UTF-8 without replacing original bytes', async () => {
    const { file, config } = await fixture()
    const bytes = Buffer.concat([Buffer.from('{"other":"'), Buffer.from([0xff]), Buffer.from('"}')])
    await writeFile(file, bytes)
    await expect(config.read()).rejects.toMatchObject({ code: 'invalid-config' })
    await expect(
      config.create({ id: 'custom-new', expectedRevision: 'missing', endpoint })
    ).rejects.toMatchObject({ code: 'invalid-config' })
    expect(await readFile(file)).toEqual(bytes)
  })

  it('distinguishes absence from empty objects and refuses stale or queued revisions', async () => {
    const { file, config } = await fixture()
    const absent = await config.read()
    await writeFile(file, '{}')
    const present = await config.read()
    expect(present.revision).not.toBe(absent.revision)
    await expect(
      config.create({ id: 'custom-old', expectedRevision: absent.revision, endpoint })
    ).rejects.toMatchObject({ code: 'conflict' })
    const results = await Promise.allSettled([
      config.create({ id: 'custom-first', expectedRevision: present.revision, endpoint }),
      config.create({ id: 'custom-second', expectedRevision: present.revision, endpoint })
    ])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } })
    expect((await config.read()).endpoints.map((item) => item.id)).toEqual(['custom-first'])
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  it.each(['write', 'sync', 'rename', 'permission'] as const)(
    'preserves original bytes and cleans only its own temp after %s failure',
    async (fault) => {
      const source = document(provider)
      const { file, dir } = await fixture(source)
      const sentinel = join(dir, '.pi-models-unrelated.tmp')
      await writeFile(sentinel, 'unrelated fixture')
      const io: CustomEndpointConfigIo = {
        ...fs,
        open: async (filePath, flags, mode) => {
          if (flags === 'wx' && fault === 'permission')
            throw new Error('EACCES fixture-secret path')
          const handle = await fs.open(filePath, flags, mode)
          if (flags !== 'wx') return handle
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'writeFile' && fault === 'write')
                return async () => {
                  await target.writeFile('partial fixture')
                  throw new Error('fixture-secret')
                }
              if (property === 'sync' && fault === 'sync')
                return async () => {
                  throw new Error('fixture-secret')
                }
              const value = Reflect.get(target, property)
              return typeof value === 'function' ? value.bind(target) : value
            }
          })
        },
        rename: async (from, to) => {
          if (fault === 'rename') throw new Error('fixture-secret')
          await fs.rename(from, to)
        }
      }
      const config = new CustomEndpointConfig(file, { io })
      const before = await config.read()
      const operation = config.update({
        id: 'custom-fixture',
        expectedRevision: before.revision,
        endpoint: { ...endpoint, label: 'New' }
      })
      await expect(operation).rejects.toMatchObject({
        code: 'io',
        message: '无法读写 Pi 模型配置，请检查文件权限后重试'
      })
      expect(await readFile(file, 'utf8')).toBe(source)
      expect(await fs.readdir(dir)).toEqual(['.pi-models-unrelated.tmp', 'models.json'])
      expect(await readFile(sentinel, 'utf8')).toBe('unrelated fixture')
    }
  )

  it('never deletes a preexisting temp when exclusive creation fails', async () => {
    const { file, dir } = await fixture('{}')
    let collisionFile = ''
    const io: CustomEndpointConfigIo = {
      ...fs,
      open: async (filePath, flags, mode) => {
        if (flags === 'wx') {
          collisionFile = String(filePath)
          await writeFile(filePath, 'existing owner')
        }
        return fs.open(filePath, flags, mode)
      }
    }
    const config = new CustomEndpointConfig(file, { io })
    const before = await config.read()
    await expect(
      config.create({ id: 'custom-new', expectedRevision: before.revision, endpoint })
    ).rejects.toMatchObject({ code: 'io' })
    expect(await readFile(file, 'utf8')).toBe('{}')
    expect(await readFile(collisionFile, 'utf8')).toBe('existing owner')
    expect(await fs.readdir(dir)).toHaveLength(2)
  })

  it('keeps the original safe if cleanup itself is denied, leaving only its private temp', async () => {
    const { file, dir } = await fixture('{}')
    const io: CustomEndpointConfigIo = {
      ...fs,
      rename: async () => {
        throw new Error('fixture-secret rename')
      },
      unlink: async () => {
        throw new Error('fixture-secret permission')
      }
    }
    const config = new CustomEndpointConfig(file, { io })
    const before = await config.read()
    await expect(
      config.create({ id: 'custom-new', expectedRevision: before.revision, endpoint })
    ).rejects.toMatchObject({ code: 'io', message: '无法读写 Pi 模型配置，请检查文件权限后重试' })
    expect(await readFile(file, 'utf8')).toBe('{}')
    const remaining = (await fs.readdir(dir)).filter((name) => name !== 'models.json')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatch(/^\.pi-models-[a-f0-9-]+\.tmp$/)
    expect((await fs.stat(join(dir, remaining[0]))).mode & 0o777).toBe(0o600)
  })

  it('checks the original again after temp write and preserves an external edit', async () => {
    const { file, dir } = await fixture('{}')
    const external = '{"external":"preserve me"}'
    const io: CustomEndpointConfigIo = {
      ...fs,
      open: async (filePath, flags, mode) => {
        const handle = await fs.open(filePath, flags, mode)
        if (flags === 'wx') await writeFile(file, external)
        return handle
      }
    }
    const config = new CustomEndpointConfig(file, { io })
    const before = await config.read()
    await expect(
      config.create({ id: 'custom-new', expectedRevision: before.revision, endpoint })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(file, 'utf8')).toBe(external)
    expect(await fs.readdir(dir)).toEqual(['models.json'])
  })

  it('rejects symlink and directory targets without changing their contents', async () => {
    const { file, dir } = await fixture()
    const target = join(dir, 'target.json')
    await writeFile(target, '{}')
    await fs.symlink(target, file)
    const config = new CustomEndpointConfig(file)
    await expect(config.read()).rejects.toMatchObject({ code: 'invalid-config' })
    await expect(
      config.create({ id: 'custom-new', expectedRevision: 'missing', endpoint })
    ).rejects.toMatchObject({ code: 'invalid-config' })
    expect(await readFile(target, 'utf8')).toBe('{}')
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true)
    await expect(new CustomEndpointConfig(dir).read()).rejects.toMatchObject({
      code: 'invalid-config'
    })
  })

  it('stops growing-file reads at the byte bound even if stat reported a small file', async () => {
    const { file } = await fixture('{}')
    let observedReadSize = 0
    const io: CustomEndpointConfigIo = {
      ...fs,
      open: async (filePath, flags, mode) => {
        const handle = await fs.open(filePath, flags, mode)
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'read')
              return async (buffer: Buffer, offset: number, length: number) => {
                observedReadSize += length
                buffer.fill(32, offset, offset + length)
                return { bytesRead: length, buffer }
              }
            const value = Reflect.get(target, property)
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      }
    }
    await expect(new CustomEndpointConfig(file, { io }).read()).rejects.toMatchObject({
      code: 'invalid-config'
    })
    expect(observedReadSize).toBe(1024 * 1024 + 1)
  })

  it('sanitizes filesystem read exceptions', async () => {
    const { file } = await fixture('{}')
    const io: CustomEndpointConfigIo = {
      ...fs,
      lstat: async () => {
        throw new Error('EACCES fixture-secret /private/path')
      }
    }
    await expect(new CustomEndpointConfig(file, { io }).read()).rejects.toMatchObject({
      code: 'io',
      message: '无法读写 Pi 模型配置，请检查文件权限后重试'
    })
  })
})
