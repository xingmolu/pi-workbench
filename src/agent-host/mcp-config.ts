import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser'
import {
  mcpIdSchema,
  mcpServerSchema,
  type McpCommand,
  type McpServer,
  type McpSnapshot
} from '../shared/mcp'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
type Loaded = {
  text: string
  document: Record<string, unknown>
  servers: Record<string, unknown>
  trusted: Record<string, unknown>
}
export class McpConfigStore {
  constructor(readonly path: string) {}
  private async load(): Promise<Loaded> {
    let text = '{}'
    try {
      const stat = await lstat(this.path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 524288)
        throw new Error('Unsupported config')
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const errors: ParseError[] = []
    const document: unknown = parse(text, errors, { allowTrailingComma: true })
    if (
      errors.length ||
      !object(document) ||
      (document.mcpServers !== undefined && !object(document.mcpServers))
    )
      throw new Error('Invalid config')
    const servers = (document.mcpServers ?? {}) as Record<string, unknown>
    if (
      Object.keys(servers).length > 16 ||
      Object.keys(servers).some((id) => !mcpIdSchema.safeParse(id).success)
    )
      throw new Error('Unsupported server collection')
    const desktop = document.piDesktop
    if (
      desktop !== undefined &&
      (!object(desktop) ||
        (desktop.trustedServers !== undefined && !object(desktop.trustedServers)))
    )
      throw new Error('Invalid desktop config')
    const trusted = object(desktop) && object(desktop.trustedServers) ? desktop.trustedServers : {}
    return { text, document, servers, trusted }
  }
  async read(): Promise<McpSnapshot> {
    try {
      const data = await this.load()
      return {
        revision: hash(data.text),
        writable: true,
        servers: Object.entries(data.servers).map(([id, raw]) => {
          const parsed = mcpServerSchema.safeParse(raw)
          if (!parsed.success)
            return {
              id,
              transport: 'unsupported',
              envKeys: [],
              headerKeys: [],
              enabled: false,
              editable: false,
              status: 'unsupported',
              toolCount: 0,
              message: '高级配置保留但不执行，请在配置文件中管理。'
            }
          const server = parsed.data
          const enabled = server.disabled !== true && data.trusted[id] === hash(JSON.stringify(raw))
          return {
            id,
            transport: server.command ? 'stdio' : 'http',
            command: server.command,
            args: server.args,
            url: server.url,
            timeout: server.timeout,
            envKeys: Object.keys(server.env ?? {}),
            headerKeys: Object.keys(server.headers ?? {}),
            enabled,
            editable: true,
            status: enabled ? 'disconnected' : server.disabled ? 'disabled' : 'untrusted',
            toolCount: 0
          }
        })
      }
    } catch {
      return {
        revision: '',
        writable: false,
        servers: [],
        message: 'MCP 配置损坏、过大或不可读取；未覆盖现有文件。'
      }
    }
  }
  async enabled(): Promise<Record<string, McpServer>> {
    const data = await this.load()
    const result: Record<string, McpServer> = {}
    for (const [id, raw] of Object.entries(data.servers)) {
      const parsed = mcpServerSchema.safeParse(raw)
      if (parsed.success && !parsed.data.disabled && data.trusted[id] === hash(JSON.stringify(raw)))
        result[id] = parsed.data
    }
    return result
  }
  async save(command: Extract<McpCommand, { type: 'mcp:save' | 'mcp:toggle' }>): Promise<void> {
    const data = await this.load()
    if (hash(data.text) !== command.revision) throw new Error('MCP 配置已变化，请刷新后重试。')
    const exists = Object.hasOwn(data.servers, command.id)
    if (command.type === 'mcp:save' && command.create === exists)
      throw new Error('服务器名称重复或目标已移除，请刷新。')
    if (exists && !mcpServerSchema.safeParse(data.servers[command.id]).success)
      throw new Error('高级配置只读。')
    if (!exists && (command.type === 'mcp:toggle' || Object.keys(data.servers).length >= 16))
      throw new Error('服务器不可用或已达到 16 个上限。')
    const previous = exists ? mcpServerSchema.parse(data.servers[command.id]) : undefined
    const updated =
      command.type === 'mcp:toggle'
        ? { ...previous, disabled: !command.enabled }
        : {
            ...command.server,
            ...(command.server.command && command.server.env === undefined && previous?.env
              ? { env: previous.env }
              : {}),
            ...(command.server.url && command.server.headers === undefined && previous?.headers
              ? { headers: previous.headers }
              : {}),
            disabled: !command.enabled
          }
    const server = mcpServerSchema.parse(updated)
    const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } }
    let text = applyEdits(data.text, modify(data.text, ['mcpServers', command.id], server, options))
    if (command.enabled || Object.hasOwn(data.trusted, command.id))
      text = applyEdits(
        text,
        modify(
          text,
          ['piDesktop', 'trustedServers', command.id],
          command.enabled ? hash(JSON.stringify(server)) : undefined,
          options
        )
      )
    if (Buffer.byteLength(text) > 524288) throw new Error('配置超过大小上限。')
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${randomUUID()}.tmp`
    try {
      const file = await open(temp, 'wx', 0o600)
      try {
        await file.writeFile(text)
        await file.sync()
      } finally {
        await file.close()
      }
      if (hash((await this.load()).text) !== command.revision)
        throw new Error('配置被其他程序修改，请刷新。')
      await rename(temp, this.path)
    } finally {
      await unlink(temp).catch(() => {})
    }
  }
}
