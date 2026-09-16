import { beforeEach, expect, it, vi } from 'vitest'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { McpRuntime } from './mcp-runtime'

const sdk = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  transport: vi.fn()
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = sdk.connect
    close = sdk.close
    listTools = sdk.listTools
    callTool = sdk.callTool
  }
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(options: unknown) {
      sdk.transport(options)
    }
    close = sdk.close
  }
}))
type Execute = (
  id: string,
  args: { action: string; server?: string; tool?: string; arguments?: Record<string, unknown> },
  signal?: AbortSignal
) => Promise<unknown>
function executable(runtime: McpRuntime): Execute {
  let execute: Execute | undefined
  const extension = runtime.extension()
  const factory = typeof extension === 'function' ? extension : extension.factory
  factory({
    on: vi.fn(),
    registerTool: (tool: { execute: Execute }) => {
      execute = tool.execute
    }
  } as unknown as ExtensionAPI)
  return execute!
}
beforeEach(() => {
  vi.clearAllMocks()
  sdk.connect.mockResolvedValue(undefined)
  sdk.close.mockResolvedValue(undefined)
  sdk.listTools.mockResolvedValue({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] })
  sdk.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
})
it('retains the mutation lease when a dispatched call times out without a completion receipt', async () => {
  const release = vi.fn()
  sdk.callTool.mockRejectedValueOnce(new Error('timed out'))
  const runtime = new McpRuntime(
    { fixture: { command: 'not-executed' } },
    '/fixture',
    async () => true,
    async () => true,
    async () => release
  )
  await expect(
    executable(runtime)('call', { action: 'call', server: 'fixture', tool: 'echo' })
  ).rejects.toThrow('MCP 调用失败')
  expect(release).not.toHaveBeenCalled()
  await runtime.close()
  expect(release).not.toHaveBeenCalled()
})
it('releases the mutation lease after a server completion receipt', async () => {
  const release = vi.fn()
  const runtime = new McpRuntime(
    { fixture: { command: 'not-executed' } },
    '/fixture',
    async () => true,
    async () => true,
    async () => release
  )
  await executable(runtime)('call', { action: 'call', server: 'fixture', tool: 'echo' })
  expect(release).toHaveBeenCalledOnce()
  await runtime.close()
})
it.each(['close', 'reload'] as const)(
  'never starts a stale connection after %s during trust validation',
  async (operation) => {
    let release!: (value: boolean) => void
    const current = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        })
    )
    const runtime = new McpRuntime(
      { fixture: { command: 'not-executed' } },
      '/fixture',
      async () => true,
      current
    )
    const result = executable(runtime)('call', { action: 'describe', server: 'fixture' })
    const rejected = expect(result).rejects.toThrow('MCP 调用失败')
    expect(current).toHaveBeenCalledOnce()
    if (operation === 'close') await runtime.close()
    else await runtime.reload({})
    release(true)
    await rejected
    expect(sdk.transport).not.toHaveBeenCalled()
    expect(sdk.connect).not.toHaveBeenCalled()
  }
)
it('redacts reflected secrets in approval title, arguments and tool result', async () => {
  const secret = 'fixture-private-token'
  sdk.listTools.mockResolvedValue({ tools: [{ name: secret, inputSchema: { type: 'object' } }] })
  sdk.callTool.mockResolvedValue({ content: [{ type: 'text', text: secret }] })
  const approve = vi.fn(async () => true)
  const runtime = new McpRuntime(
    { fixture: { command: 'not-executed', env: { KEY: secret } } },
    '/fixture',
    approve
  )
  const result = await executable(runtime)('call', {
    action: 'call',
    server: 'fixture',
    tool: secret,
    arguments: { reflected: secret }
  })
  expect(approve).toHaveBeenCalledOnce()
  expect(JSON.stringify(approve.mock.calls)).not.toContain(secret)
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(sdk.callTool).toHaveBeenCalledOnce()
  await runtime.close()
})
it('does not trust remote exceptions impersonating local validation errors', async () => {
  sdk.callTool.mockRejectedValue(new Error('MCP 参数 private-token-from-server'))
  const runtime = new McpRuntime(
    { fixture: { command: 'not-executed' } },
    '/fixture',
    async () => true
  )
  await expect(
    executable(runtime)('call', { action: 'call', server: 'fixture', tool: 'echo' })
  ).rejects.toThrow(/^MCP 调用失败，完成状态未确认；同项目写入将等待当前会话进程退出。$/)
  await runtime.close()
})
it('rejects denied approval and a config changed while approval was pending without calling server', async () => {
  for (const allowed of [false, true]) {
    const current = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    const runtime = new McpRuntime(
      { fixture: { command: 'not-executed' } },
      '/fixture',
      async () => allowed,
      current
    )
    await expect(
      executable(runtime)('call', { action: 'call', server: 'fixture', tool: 'echo' })
    ).rejects.toThrow(allowed ? '配置已改变' : '用户拒绝')
    expect(sdk.callTool).not.toHaveBeenCalled()
    await runtime.close()
  }
})
