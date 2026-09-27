import { describe, expect, it } from 'vitest'
import type { PermissionMode } from '../shared/contracts'
import { piToolCategory, ToolGate, type GatedToolCall, type ToolCategory } from './tool-gate'

function gate(mode: PermissionMode, options: { answer?: boolean; rules?: boolean } = {}) {
  const log: string[] = []
  const tool = new ToolGate({
    mode: () => mode,
    rulesAllow: (call, auto) => {
      log.push(`rules ${call.tool} auto=${auto}`)
      return options.rules ?? false
    },
    confirm: async (call) => {
      log.push(`confirm ${call.tool}`)
      return options.answer ?? true
    },
    acquire: async (call) => {
      log.push(`acquire ${call.toolCallId}`)
    },
    release: (id) => log.push(`release ${id}`),
    checkpoint: {
      capture: (call) => log.push(`capture ${call.toolCallId}`),
      settle: (_session, id) => log.push(`settle ${id}`)
    }
  })
  return { tool, log }
}

const call = (category: ToolCategory, extra: Partial<GatedToolCall> = {}): GatedToolCall => ({
  sessionId: 's1',
  toolCallId: 'c1',
  tool: category,
  category,
  input: {},
  cwd: '/p',
  ...extra
})

describe('tool gate', () => {
  it('lets reads, tasks and MCP through without asking or locking', async () => {
    for (const category of ['read', 'task', 'mcp'] as const) {
      const { tool, log } = gate('ask')
      await expect(tool.before(call(category))).resolves.toEqual({ decision: 'allow' })
      expect(log).toEqual([])
    }
  })

  it('asks for shell and file tools at the ask level, then locks and checkpoints writes', async () => {
    const { tool, log } = gate('ask')
    await expect(tool.before(call('file.write'))).resolves.toEqual({ decision: 'allow' })
    tool.after({ sessionId: 's1', toolCallId: 'c1', category: 'file.write', ok: true })
    expect(log).toEqual([
      'rules file.write auto=false',
      'confirm file.write',
      'acquire c1',
      'capture c1',
      'settle c1',
      'release c1'
    ])
  })

  it('uses project rules before asking and never asks at full access', async () => {
    const ruled = gate('auto', { rules: true })
    await ruled.tool.before(call('shell'))
    expect(ruled.log).toEqual(['rules shell auto=true', 'acquire c1'])
    const open = gate('open')
    await open.tool.before(call('shell'))
    expect(open.log).toEqual(['acquire c1'])
  })

  it('denies when the user refuses', async () => {
    const { tool, log } = gate('ask', { answer: false })
    await expect(tool.before(call('file.edit'))).resolves.toMatchObject({ decision: 'deny' })
    expect(log).not.toContain('acquire c1')
  })

  it('always confirms computer use, even at full access', async () => {
    const { tool, log } = gate('open')
    await tool.before(call('computer'))
    expect(log).toEqual(['confirm computer'])
  })

  it('confirms plugin tools only at the ask level and not when they are read-only', async () => {
    const expectations: [PermissionMode, boolean, boolean][] = [
      ['ask', false, true],
      ['ask', true, false],
      ['auto', false, false],
      ['open', false, false]
    ]
    for (const [mode, readOnly, asks] of expectations) {
      const { tool, log } = gate(mode)
      await expect(tool.before(call('plugin', { tool: 'acme_lookup', readOnly }))).resolves.toEqual(
        { decision: 'allow' }
      )
      expect(log).toEqual(asks ? ['confirm acme_lookup'] : [])
    }
  })

  it('refuses locked work without a session', async () => {
    const { tool } = gate('open')
    await expect(tool.before(call('shell', { sessionId: null }))).resolves.toEqual({
      decision: 'deny',
      reason: '会话已结束'
    })
  })
})

describe('pi tool categories', () => {
  it('maps pi tool names and plugin tools onto categories', () => {
    expect(piToolCategory('bash', {}).category).toBe('shell')
    expect(piToolCategory('write', {}).category).toBe('file.write')
    expect(piToolCategory('edit', {}).category).toBe('file.edit')
    expect(piToolCategory('browser', { action: 'snapshot' }).category).toBe('read')
    expect(piToolCategory('browser', { action: 'click' }).category).toBe('browser')
    expect(piToolCategory('computer', { action: 'observe' }).category).toBe('read')
    expect(piToolCategory('computer', { action: 'act' }).category).toBe('computer')
    expect(piToolCategory('read', {}).category).toBe('read')
    expect(
      piToolCategory('acme_lookup', {}, (name) =>
        name === 'acme_lookup' ? { readOnly: true } : undefined
      )
    ).toEqual({ category: 'plugin', readOnly: true })
  })
})
