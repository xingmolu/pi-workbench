import { describe, expect, it } from 'vitest'
import type { PluginAgentRequest } from '../shared/plugin-agent'
import { PluginAgentClient } from './plugin-agent-client'

describe('plugin agent client', () => {
  it('resolves contributions from Main and falls back to none on timeout', async () => {
    const sent: PluginAgentRequest[] = []
    const client = new PluginAgentClient((message) => sent.push(message), 20)
    const answered = client.contributions()
    const request = sent[0] as { requestId: string }
    client.accept({
      type: 'plugin-agent-contributions',
      requestId: request.requestId,
      contributions: { tools: [], skillPaths: ['/s'], mcpServers: {} }
    })
    await expect(answered).resolves.toMatchObject({ skillPaths: ['/s'] })
    await expect(client.contributions()).resolves.toEqual({
      tools: [],
      skillPaths: [],
      mcpServers: {}
    })
  })

  it('routes tool calls, surfaces errors and sends a cancel on abort', async () => {
    const sent: PluginAgentRequest[] = []
    const client = new PluginAgentClient((message) => sent.push(message))
    const tool = { pluginId: 'acme.notes', name: 'lookup' }
    const context = { cwd: '/work/shop', sessionId: 's1' }

    const ok = client.runTool(tool, { q: 1 }, context)
    expect(sent[0]).toMatchObject({ type: 'plugin-tool-request', name: 'lookup', input: { q: 1 } })
    client.accept({
      type: 'plugin-tool-response',
      requestId: (sent[0] as { requestId: string }).requestId,
      ok: true,
      text: 'done'
    })
    await expect(ok).resolves.toBe('done')

    const failed = client.runTool(tool, {}, context)
    client.accept({
      type: 'plugin-tool-response',
      requestId: (sent[1] as { requestId: string }).requestId,
      ok: false,
      error: '插件工具超时'
    })
    await expect(failed).rejects.toThrow('插件工具超时')

    const controller = new AbortController()
    const cancelled = client.runTool(tool, {}, context, controller.signal)
    controller.abort()
    await expect(cancelled).rejects.toThrow('已取消')
    expect(sent.at(-1)).toMatchObject({ type: 'plugin-tool-cancel' })
  })
})
