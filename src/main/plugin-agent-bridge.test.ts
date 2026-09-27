import { describe, expect, it } from 'vitest'
import type { PluginAgentResponse } from '../shared/plugin-agent'
import { PluginAgentBridge } from './plugin-agent-bridge'

function setup(project: string | null = '/work/shop') {
  const replies: PluginAgentResponse[] = []
  const runs: { pluginId: string; name: string; input: unknown; signal: AbortSignal }[] = []
  let finish: (text: string) => void = () => undefined
  const bridge = new PluginAgentBridge({
    contributions: async () => ({
      tools: [],
      skillPaths: ['/plugins/notes/skills'],
      mcpServers: {}
    }),
    runTool: (pluginId, name, input, signal) => {
      runs.push({ pluginId, name, input, signal })
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    foregroundProject: () => project,
    canonicalize: async (path) => path.replace(/\/$/, '')
  })
  const reply = (response: PluginAgentResponse): void => {
    replies.push(response)
  }
  return { bridge, replies, runs, reply, finish: (text: string) => finish(text) }
}

const flush = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0))

describe('plugin agent bridge', () => {
  it('ignores unrelated messages and answers contribution requests', async () => {
    const { bridge, replies, reply } = setup()
    expect(bridge.handle('w1', { type: 'project-mutation' }, reply)).toBe(false)
    expect(
      bridge.handle('w1', { type: 'plugin-agent-contributions-request', requestId: 'r1' }, reply)
    ).toBe(true)
    await flush()
    expect(replies[0]).toMatchObject({
      type: 'plugin-agent-contributions',
      requestId: 'r1',
      contributions: { skillPaths: ['/plugins/notes/skills'] }
    })
  })

  it('runs tools for sessions in the open project and cancels per owner', async () => {
    const { bridge, replies, runs, reply, finish } = setup()
    const request = {
      type: 'plugin-tool-request',
      requestId: 'r2',
      sessionId: 's1',
      pluginId: 'acme.notes',
      name: 'lookup',
      input: { q: 'tax' },
      cwd: '/work/shop/'
    }
    bridge.handle('w1', request, reply)
    await flush()
    expect(runs[0]).toMatchObject({ pluginId: 'acme.notes', name: 'lookup', input: { q: 'tax' } })
    finish('rate 0.1')
    await flush()
    expect(replies.at(-1)).toEqual({
      type: 'plugin-tool-response',
      requestId: 'r2',
      ok: true,
      text: 'rate 0.1'
    })

    bridge.handle('w1', { ...request, requestId: 'r3' }, reply)
    await flush()
    bridge.cancelOwner('w1')
    expect(runs[1].signal.aborted).toBe(true)
  })

  it('refuses tool calls from sessions in another project', async () => {
    const { bridge, replies, runs, reply } = setup('/work/other')
    bridge.handle(
      'w1',
      {
        type: 'plugin-tool-request',
        requestId: 'r4',
        sessionId: 's1',
        pluginId: 'acme.notes',
        name: 'lookup',
        input: {},
        cwd: '/work/shop'
      },
      reply
    )
    await flush()
    await flush()
    expect(runs).toEqual([])
    expect(replies.at(-1)).toMatchObject({ ok: false, error: expect.stringContaining('当前窗口') })
  })
})
