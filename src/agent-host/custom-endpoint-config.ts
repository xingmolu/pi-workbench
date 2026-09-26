import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  applyEdits,
  createScanner,
  getNodeValue,
  modify,
  parseTree,
  type Node,
  type ParseError
} from 'jsonc-parser'
import {
  customEndpointApiSchema,
  customEndpointMetadataInputSchema,
  customEndpointUrlSchema,
  isCustomEndpointId,
  type CustomEndpointConfigSnapshot,
  type CustomEndpointMetadata,
  type CustomEndpointMetadataInput
} from '../shared/custom-endpoints'

const MAX_BYTES = 1024 * 1024
// jsonc-parser 3.3.1 publishes ambient const enums, unusable with isolatedModules.
// These are its public SyntaxKind values; the scanner still handles all tokenization.
const tokenKind = { openObject: 1, closeObject: 2, openArray: 3, closeArray: 4, eof: 17 } as const
const UNSUPPORTED = '此配置包含不支持的字段或地址，请在 Pi 配置文件中管理' as const
const messages = {
  'invalid-config': 'Pi 模型配置无法安全读取，请检查配置文件',
  'invalid-input': '端点输入无效',
  conflict: 'Pi 模型配置已更改，请重新加载后再保存',
  collision: '端点标识已存在',
  'read-only': '此端点不可通过表单编辑',
  io: '无法读写 Pi 模型配置，请检查文件权限后重试'
} as const
export class CustomEndpointConfigError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code])
    this.name = 'CustomEndpointConfigError'
  }
}
function fail(code: keyof typeof messages): never {
  throw new CustomEndpointConfigError(code)
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function supportedInput(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      ((value.length === 1 && value[0] === 'text') ||
        (value.length === 2 && value.includes('text') && value.includes('image'))))
  )
}

function parseDocument(text: string): Record<string, Record<string, unknown>> {
  const scanner = createScanner(text, true)
  let depth = 0
  for (let token = scanner.scan(); token !== tokenKind.eof; token = scanner.scan()) {
    if (token === tokenKind.openObject || token === tokenKind.openArray) {
      if (++depth > 32) fail('invalid-config')
    } else if (token === tokenKind.closeObject || token === tokenKind.closeArray) {
      if (--depth < 0) fail('invalid-config')
    }
  }
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { allowTrailingComma: false })
  if (!root || root.type !== 'object' || errors.length) fail('invalid-config')
  const pending: Node[] = [root]
  while (pending.length) {
    const node = pending.pop()!
    if (node.type === 'object') {
      const keys = new Set<string>()
      for (const property of node.children ?? []) {
        const key: string = property.children![0].value
        if (keys.has(key)) fail('invalid-config')
        keys.add(key)
      }
    }
    for (const child of node.children ?? []) pending.push(child)
  }
  const value: unknown = getNodeValue(root)
  if (!object(value)) fail('invalid-config')
  if (!Object.hasOwn(value, 'providers')) return Object.create(null)
  if (!object(value.providers) || Object.keys(value.providers).length > 1000) fail('invalid-config')
  const providers: Record<string, Record<string, unknown>> = Object.create(null)
  for (const [id, provider] of Object.entries(value.providers)) {
    if (!object(provider)) fail('invalid-config')
    providers[id] = provider
  }
  return providers
}

const routingFields = ['key', 'apiKey', 'headers', 'modelOverrides', 'auth', 'authHeader', 'oauth']
function project(
  id: string,
  provider: Record<string, unknown>,
  protectedIds: ReadonlySet<string>
): CustomEndpointMetadata {
  const models = Array.isArray(provider.models) ? provider.models : []
  const candidate = customEndpointMetadataInputSchema.safeParse({
    label: provider.name ?? id,
    api: provider.api,
    baseUrl: provider.baseUrl,
    modelIds: models.map((model) => (object(model) ? model.id : null))
  })
  const advanced =
    routingFields.some((field) => Object.hasOwn(provider, field)) ||
    models.some(
      (model) =>
        !object(model) ||
        !supportedInput(model.input) ||
        (typeof model.id === 'string' && model.id !== model.id.trim()) ||
        [...routingFields, 'api', 'baseUrl'].some((field) => Object.hasOwn(model, field))
    )
  const editable = isCustomEndpointId(id) && !protectedIds.has(id) && candidate.success && !advanced
  const label = customEndpointMetadataInputSchema.shape.label.safeParse(provider.name ?? id)
  const api = customEndpointApiSchema.safeParse(provider.api)
  const url = customEndpointUrlSchema.safeParse(provider.baseUrl)
  const ids = customEndpointMetadataInputSchema.shape.modelIds.safeParse(
    models.map((model) => (object(model) ? model.id : null))
  )
  return {
    id,
    label: label.success ? label.data : '未命名端点',
    api: api.success ? api.data : null,
    baseUrl: url.success ? url.data : null,
    modelIds: ids.success ? ids.data : [],
    imageModelIds: ids.success
      ? models.flatMap((model) =>
          object(model) &&
          Array.isArray(model.input) &&
          model.input.includes('image') &&
          typeof model.id === 'string' &&
          ids.data.includes(model.id)
            ? [model.id]
            : []
        )
      : [],
    editable,
    unsupportedReason: editable ? null : UNSUPPORTED
  }
}

export type CustomEndpointConfigIo = Pick<typeof fs, 'open' | 'lstat' | 'rename' | 'unlink'>
type Document = {
  text: string
  bom: string
  revision: string
  providers: Record<string, Record<string, unknown>>
}
export type CustomEndpointConfigWrite = {
  id: string
  expectedRevision: string
  endpoint: CustomEndpointMetadataInput
}

/** Only models.json metadata belongs here. Credential persistence is a separate public SDK operation. */
export class CustomEndpointConfig {
  private readonly io: CustomEndpointConfigIo
  private readonly protectedIds: ReadonlySet<string>
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly modelsFilePath: string,
    options: { io?: CustomEndpointConfigIo; protectedProviderIds?: readonly string[] } = {}
  ) {
    this.io = options.io ?? fs
    this.protectedIds = new Set(options.protectedProviderIds)
  }

  private async safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof CustomEndpointConfigError) throw error
      throw new CustomEndpointConfigError('io')
    }
  }

  private async document(): Promise<Document> {
    let missing = false
    try {
      if (!(await this.io.lstat(this.modelsFilePath)).isFile()) fail('invalid-config')
    } catch (error) {
      if (object(error) && error.code === 'ENOENT') missing = true
      else throw error
    }
    if (missing)
      return { text: '{}\n', bom: '', revision: 'missing', providers: Object.create(null) }
    const handle = await this.io.open(
      this.modelsFilePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    let bytes: Buffer
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_BYTES) fail('invalid-config')
      const buffer = Buffer.alloc(MAX_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const chunk = await handle.read(buffer, length, buffer.length - length, null)
        if (chunk.bytesRead === 0) break
        length += chunk.bytesRead
      }
      if (length > MAX_BYTES) fail('invalid-config')
      bytes = buffer.subarray(0, length)
    } finally {
      await handle.close()
    }
    // Fatal UTF-8 decoding prevents a save from silently replacing invalid original bytes.
    let decoded: string
    try {
      decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      fail('invalid-config')
    }
    const bom = decoded.startsWith('\uFEFF') ? '\uFEFF' : ''
    const text = decoded.slice(bom.length)
    return {
      text,
      bom,
      revision: createHash('sha256').update(bytes).digest('hex'),
      providers: parseDocument(text)
    }
  }

  private snapshot(document: Document): CustomEndpointConfigSnapshot {
    return {
      revision: document.revision,
      endpoints: Object.entries(document.providers).map(([id, provider]) =>
        project(id, provider, this.protectedIds)
      )
    }
  }

  read(): Promise<CustomEndpointConfigSnapshot> {
    return this.safe(async () => this.snapshot(await this.document()))
  }

  create(input: CustomEndpointConfigWrite): Promise<CustomEndpointConfigSnapshot> {
    return this.save(input, true)
  }
  update(input: CustomEndpointConfigWrite): Promise<CustomEndpointConfigSnapshot> {
    return this.save(input, false)
  }

  private save(
    input: CustomEndpointConfigWrite,
    creating: boolean
  ): Promise<CustomEndpointConfigSnapshot> {
    const operation = this.queue.then(() =>
      this.safe(async () => {
        const parsed = customEndpointMetadataInputSchema.safeParse(input.endpoint)
        if (
          !parsed.success ||
          !isCustomEndpointId(input.id) ||
          typeof input.expectedRevision !== 'string'
        )
          fail('invalid-input')
        const endpoint = parsed.data
        const original = await this.document()
        if (original.revision !== input.expectedRevision) fail('conflict')
        const existing = original.providers[input.id]
        if (this.protectedIds.has(input.id)) fail('read-only')
        if (creating && existing) fail('collision')
        if (!creating && (!existing || !project(input.id, existing, this.protectedIds).editable))
          fail('read-only')
        let text = original.text
        const set = (path: (string | number)[], value: unknown) => {
          // Formatting the edit can reformat neighbouring providers; retain their original bytes.
          text = applyEdits(text, modify(text, path, value, {}))
        }
        if (creating) {
          set(['providers', input.id], {
            name: endpoint.label,
            api: endpoint.api,
            baseUrl: endpoint.baseUrl,
            models: endpoint.modelIds.map((id) =>
              endpoint.imageModelIds?.includes(id) ? { id, input: ['text', 'image'] } : { id }
            )
          })
        } else {
          set(['providers', input.id, 'name'], endpoint.label)
          set(['providers', input.id, 'api'], endpoint.api)
          set(['providers', input.id, 'baseUrl'], endpoint.baseUrl)
          const models = existing.models as Record<string, unknown>[]
          for (let i = models.length - 1; i >= 0; i--) {
            if (!endpoint.modelIds.includes(models[i].id as string))
              set(['providers', input.id, 'models', i], undefined)
          }
          const surviving = new Set(models.map((model) => model.id))
          for (const id of endpoint.modelIds) {
            if (!surviving.has(id))
              set(
                ['providers', input.id, 'models', -1],
                endpoint.imageModelIds?.includes(id) ? { id, input: ['text', 'image'] } : { id }
              )
            else if (endpoint.imageModelIds) {
              const originalIndex = models.findIndex((model) => model.id === id)
              const model = models[originalIndex]
              const desired = endpoint.imageModelIds.includes(id) ? ['text', 'image'] : ['text']
              if (model.input === undefined && desired.length === 1) continue
              if (JSON.stringify(model.input) !== JSON.stringify(desired)) {
                // Removed models before this point shift the JSONC array index.
                const removedBefore = models
                  .slice(0, originalIndex)
                  .filter((item) => !endpoint.modelIds.includes(item.id as string)).length
                set(
                  ['providers', input.id, 'models', originalIndex - removedBefore, 'input'],
                  desired
                )
              }
            }
          }
        }
        const bytes = Buffer.from(original.bom + text)
        if (bytes.length > MAX_BYTES) fail('invalid-config')
        const providers = parseDocument(text)
        const revision = createHash('sha256').update(bytes).digest('hex')
        const temp = join(dirname(this.modelsFilePath), `.pi-models-${randomUUID()}.tmp`)
        let owned = false
        try {
          const handle = await this.io.open(temp, 'wx', 0o600)
          owned = true
          try {
            await handle.writeFile(bytes)
            await handle.sync()
          } finally {
            await handle.close()
          }
          if ((await this.document()).revision !== original.revision) fail('conflict')
          // Rename is atomic for readers, but the last revision check is not cross-process CAS.
          await this.io.rename(temp, this.modelsFilePath)
          owned = false
        } finally {
          if (owned) await this.io.unlink(temp).catch(() => undefined)
        }
        return this.snapshot({ text, bom: original.bom, revision, providers })
      })
    )
    this.queue = operation.catch(() => undefined)
    return operation
  }
}
