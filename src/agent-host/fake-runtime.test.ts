/**
 * Contract test with a fake, non-pi agent runtime. It proves the host policy does not depend
 * on pi: the runtime's own tool names map onto categories, every call passes the ToolGate,
 * plugin tools arrive over the MCP bridge (`toolDelivery: 'mcp'`), and the runtime's native
 * events normalize into the host's ConversationNode shape.
 */
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ConversationNode, PermissionMode } from '../shared/contracts'
import type { PluginAgentTool } from '../shared/plugin-agent'
import { createPluginToolMcpServer } from './plugin-tool-mcp-bridge'
import { ToolGate, type ToolCategory } from './tool-gate'

/** The fake runtime's native protocol: its own tool names and event kinds. */
type FakeCall = { id: string; tool: string; args: Record<string, unknown> }
type FakeEvent =
  | { kind: 'ToolBegin'; id: string; tool: string }
  | { kind: 'ToolDone'; id: string; tool: string; text: string; failed: boolean }

const BRIDGE_PREFIX = 'mcp__pi-desktop-plugins__'

/** The adapter's only pi-free knowledge: how its tool names map onto categories. */
function fakeToolCategory(tool: string): ToolCategory {
  if (tool === 'RunShell') return 'shell'
  if (tool === 'WriteFile') return 'file.write'
  if (tool.startsWith(BRIDGE_PREFIX)) return 'mcp'
  return 'read'
}

/** Native events → host ConversationNode. */
function normalize(event: FakeEvent): ConversationNode {
  return {
    id: `tool:${event.id}`,
    type: 'tool',
    toolCallId: event.id,
    name: event.tool,
    intent: 'generic',
    title: event.tool,
    status: event.kind === 'ToolBegin' ? 'running' : event.failed ? 'error' : 'success',
    ...(event.kind === 'ToolDone' ? { output: event.text } : {})
  }
}

const TAX_TOOL: PluginAgentTool = {
  pluginId: 'acme.tax',
  pluginName: 'Tax',
  name: 'rate',
  toolName: 'acme_tax__rate',
  title: '税率查询',
  description: 'Look up a tax rate',
  parameters: { type: 'object', properties: { region: { type: 'string' } } },
  readOnly: false
}

async function harness(mode: PermissionMode, answer = true) {
  const log: string[] = []
  const gate = new ToolGate({
    mode: () => mode,
    rulesAllow: () => false,
    confirm: async (call) => {
      log.push(`confirm ${call.category} ${call.tool}`)
      return answer
    },
    acquire: async (call) => {
      log.push(`lock ${call.tool}`)
    },
    release: () => undefined,
    checkpoint: { capture: (call) => log.push(`checkpoint ${call.tool}`), settle: () => undefined }
  })
  const bridge = createPluginToolMcpServer({
    tools: [TAX_TOOL],
    gate,
    run: async (tool, input) => {
      log.push(`plugin ${tool.pluginId}/${tool.name}`)
      return `税率 ${(input as { region: string }).region}: 6%`
    },
    context: () => ({ sessionId: 's1', cwd: '/work/shop' })
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await bridge.connect(serverTransport)
  const mcp = new Client({ name: 'fake-runtime', version: '0' })
  await mcp.connect(clientTransport)

  const events: FakeEvent[] = []
  /** The fake runtime executes one turn of tool calls through the host contract. */
  const runTurn = async (calls: FakeCall[]): Promise<void> => {
    for (const call of calls) {
      events.push({ kind: 'ToolBegin', id: call.id, tool: call.tool })
      const category = fakeToolCategory(call.tool)
      const decision = await gate.before({
        sessionId: 's1',
        toolCallId: call.id,
        tool: call.tool,
        category,
        input: call.args,
        cwd: '/work/shop'
      })
      if (decision.decision === 'deny') {
        events.push({
          kind: 'ToolDone',
          id: call.id,
          tool: call.tool,
          text: decision.reason,
          failed: true
        })
        continue
      }
      let text = 'ok'
      let failed = false
      if (category === 'mcp') {
        const result = CallToolResultSchema.parse(
          await mcp.callTool({ name: call.tool.slice(BRIDGE_PREFIX.length), arguments: call.args })
        )
        text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
        failed = result.isError === true
      }
      gate.after({ sessionId: 's1', toolCallId: call.id, category, ok: !failed })
      events.push({ kind: 'ToolDone', id: call.id, tool: call.tool, text, failed })
    }
  }
  return { log, events, runTurn, mcp }
}

const TURN: FakeCall[] = [
  { id: 'c1', tool: 'RunShell', args: { cmd: 'ls' } },
  { id: 'c2', tool: 'WriteFile', args: { path: 'a.txt' } },
  { id: 'c3', tool: `${BRIDGE_PREFIX}acme_tax__rate`, args: { region: 'shanghai' } }
]

describe('a fake non-pi runtime on the host contract', () => {
  it('discovers plugin tools over the MCP bridge', async () => {
    const { mcp } = await harness('ask')
    const { tools } = await mcp.listTools()
    expect(tools).toEqual([
      expect.objectContaining({
        name: 'acme_tax__rate',
        title: 'Tax · 税率查询',
        annotations: expect.objectContaining({ readOnlyHint: false })
      })
    ])
  })

  it('asks for every tool at the ask level, locks shell and file work, and runs the plugin tool', async () => {
    const { log, events, runTurn } = await harness('ask')
    await runTurn(TURN)
    expect(log).toEqual([
      'confirm shell RunShell',
      'lock RunShell',
      'confirm file.write WriteFile',
      'lock WriteFile',
      'checkpoint WriteFile',
      'confirm plugin acme_tax__rate',
      'plugin acme.tax/rate'
    ])
    const nodes = events.map(normalize)
    expect(nodes.at(-1)).toMatchObject({
      type: 'tool',
      toolCallId: 'c3',
      status: 'success',
      output: '税率 shanghai: 6%'
    })
  })

  it('runs everything without asking at full access', async () => {
    const { log, runTurn } = await harness('open')
    await runTurn(TURN)
    expect(log.filter((line) => line.startsWith('confirm'))).toEqual([])
    expect(log).toContain('plugin acme.tax/rate')
  })

  it('auto-approves plugin tools at the auto level but still asks for unruled shell work', async () => {
    const { log, runTurn } = await harness('auto')
    await runTurn(TURN)
    expect(log.filter((line) => line.startsWith('confirm'))).toEqual([
      'confirm shell RunShell',
      'confirm file.write WriteFile'
    ])
  })

  it('reports a refused plugin tool as a failed node and never runs it', async () => {
    const { log, events, runTurn } = await harness('ask', false)
    await runTurn([TURN[2]])
    expect(log).not.toContain('plugin acme.tax/rate')
    expect(normalize(events.at(-1)!)).toMatchObject({
      status: 'error',
      output: '用户拒绝了这次工具调用'
    })
  })
})
