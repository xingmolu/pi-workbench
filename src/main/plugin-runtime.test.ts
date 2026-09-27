import { describe, expect, it, vi } from 'vitest'
import type { PluginProcessMessage } from '../shared/plugin-api'
import {
  PluginRuntime,
  type PluginAuditEntry,
  type PluginProcessHandle,
  type RuntimePlugin
} from './plugin-runtime'

class FakeProcess implements PluginProcessHandle {
  sent: PluginProcessMessage[] = []
  private messageListeners: ((message: unknown) => void)[] = []
  private exitListeners: ((code: number) => void)[] = []
  killed = false
  postMessage(message: PluginProcessMessage): void {
    this.sent.push(message)
  }
  onMessage(listener: (message: unknown) => void): void {
    this.messageListeners.push(listener)
  }
  onExit(listener: (code: number) => void): void {
    this.exitListeners.push(listener)
  }
  kill(): void {
    this.killed = true
  }
  emit(message: unknown): void {
    for (const listener of this.messageListeners) listener(message)
  }
  exit(code = 1): void {
    for (const listener of this.exitListeners) listener(code)
  }
  lastReply(id: number): PluginProcessMessage | undefined {
    return this.sent.findLast((message) => message.kind === 'reply' && message.id === id)
  }
}

function plugin(overrides: Partial<RuntimePlugin> = {}): RuntimePlugin {
  return {
    pluginId: 'acme.notes',
    name: 'Notes',
    canonicalMainPath: '/plugins/notes/main.js',
    granted: new Set(['ui.view']),
    commands: [{ id: 'open', title: 'Open notes', keywords: [] }],
    views: new Map([['panel', 'acme.notes.panel']]),
    ...overrides
  }
}

function setup(timeouts = {}) {
  const processes: FakeProcess[] = []
  const audit: PluginAuditEntry[] = []
  const toasts: string[] = []
  const opened: string[] = []
  const storage = new Map<string, unknown>()
  const onChange = vi.fn()
  const runtime = new PluginRuntime({
    spawn: () => {
      const child = new FakeProcess()
      processes.push(child)
      return child
    },
    context: () => ({ projectPath: '/work/shop' }),
    storage: { get: (key) => storage.get(key), set: (key, value) => storage.set(key, value) },
    toast: (_pluginId, message) => toasts.push(message),
    openView: (viewId) => opened.push(viewId),
    audit: (entry) => audit.push(entry),
    onChange,
    timeouts
  })
  return { runtime, processes, audit, toasts, opened, storage, onChange }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('plugin runtime broker', () => {
  it('loads a plugin and exposes only declared, registered commands', async () => {
    const { runtime, processes } = setup()
    runtime.sync([plugin()])
    const child = processes[0]
    expect(child.sent[0]).toEqual({
      kind: 'load',
      pluginId: 'acme.notes',
      mainPath: '/plugins/notes/main.js'
    })
    expect(runtime.status('acme.notes')).toBe('starting')
    child.emit({ kind: 'ready' })
    expect(runtime.status('acme.notes')).toBe('running')
    expect(runtime.commands()).toEqual([])

    child.emit({ kind: 'call', id: 1, method: 'commands.register', params: { id: 'undeclared' } })
    child.emit({ kind: 'call', id: 2, method: 'commands.register', params: { id: 'open' } })
    await flush()
    expect(child.lastReply(1)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(child.lastReply(2)).toMatchObject({ ok: true })
    expect(runtime.commands()).toEqual([
      {
        pluginId: 'acme.notes',
        pluginName: 'Notes',
        commandId: 'open',
        title: 'Open notes',
        keywords: []
      }
    ])

    const run = runtime.runCommand('acme.notes', 'open')
    const invoke = child.sent.findLast((message) => message.kind === 'invoke')!
    expect(invoke).toMatchObject({ target: 'command', name: 'open' })
    child.emit({ kind: 'reply', id: (invoke as { id: number }).id, ok: true })
    await expect(run).resolves.toBeUndefined()
  })

  it('enforces allowlist, parameters and granted permissions, and audits every call', async () => {
    const { runtime, processes, audit, toasts, opened, storage } = setup()
    runtime.sync([plugin({ granted: new Set(['ui.view', 'notify']) })])
    const child = processes[0]
    child.emit({ kind: 'ready' })
    child.emit({ kind: 'call', id: 1, method: 'clipboard.read', params: {} })
    child.emit({ kind: 'call', id: 2, method: 'ui.showToast', params: { message: '' } })
    child.emit({ kind: 'call', id: 3, method: 'storage.set', params: { key: 'a', value: 1 } })
    child.emit({ kind: 'call', id: 4, method: 'ui.showToast', params: { message: 'hi' } })
    child.emit({ kind: 'call', id: 5, method: 'ui.openView', params: { id: 'panel' } })
    child.emit({ kind: 'call', id: 6, method: 'ui.openView', params: { id: 'other' } })
    await flush()
    expect(child.lastReply(1)).toMatchObject({ code: 'UNSUPPORTED' })
    expect(child.lastReply(2)).toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(child.lastReply(3)).toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(child.lastReply(4)).toMatchObject({ ok: true })
    expect(child.lastReply(6)).toMatchObject({ code: 'NOT_FOUND' })
    expect(toasts).toEqual(['hi'])
    expect(opened).toEqual(['acme.notes.panel'])
    expect(storage.size).toBe(0)
    expect(audit.map(({ method, outcome }) => `${method}:${outcome}`)).toEqual([
      'clipboard.read:UNSUPPORTED',
      'ui.showToast:INVALID_ARGUMENT',
      'storage.set:PERMISSION_DENIED',
      'ui.showToast:ok',
      'ui.openView:ok',
      'ui.openView:NOT_FOUND'
    ])
  })

  it('scopes storage per plugin and project and bounds its size', async () => {
    const { runtime, processes } = setup()
    runtime.sync([plugin({ granted: new Set(['storage']) })])
    const child = processes[0]
    child.emit({ kind: 'ready' })
    child.emit({
      kind: 'call',
      id: 1,
      method: 'storage.set',
      params: { key: 'k', value: { a: 1 } }
    })
    child.emit({ kind: 'call', id: 2, method: 'storage.get', params: { key: 'k' } })
    child.emit({
      kind: 'call',
      id: 3,
      method: 'storage.set',
      params: { key: 'big', value: 'x'.repeat(40_000) }
    })
    await flush()
    expect(child.lastReply(2)).toMatchObject({ ok: true, value: { a: 1 } })
    expect(child.lastReply(3)).toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('contains a crash: pending commands fail, commands disappear, the user is told', async () => {
    const { runtime, processes, toasts } = setup()
    runtime.sync([plugin()])
    const child = processes[0]
    child.emit({ kind: 'ready' })
    child.emit({ kind: 'call', id: 1, method: 'commands.register', params: { id: 'open' } })
    await flush()
    const run = runtime.runCommand('acme.notes', 'open')
    child.exit(1)
    await expect(run).rejects.toMatchObject({ code: 'PLUGIN_CRASHED' })
    expect(runtime.status('acme.notes')).toBe('crashed')
    expect(runtime.commands()).toEqual([])
    expect(toasts[0]).toContain('意外退出')
  })

  it('fails a plugin that never becomes ready and a plugin whose load throws', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, processes } = setup({ load: 100 })
      runtime.sync([plugin(), plugin({ pluginId: 'acme.broken', name: 'Broken' })])
      processes[1].emit({ kind: 'load-failed', message: 'boom' })
      expect(runtime.status('acme.broken')).toBe('failed')
      vi.advanceTimersByTime(100)
      expect(runtime.status('acme.notes')).toBe('failed')
      expect(processes[0].killed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops removed plugins gracefully and restarts plugins whose grants changed', () => {
    const { runtime, processes } = setup()
    runtime.sync([plugin()])
    processes[0].emit({ kind: 'ready' })
    runtime.sync([plugin({ granted: new Set(['ui.view', 'notify']) })])
    expect(processes[0].sent.at(-1)).toEqual({ kind: 'unload' })
    expect(processes).toHaveLength(2)
    runtime.sync([])
    expect(processes[1].sent.at(-1)).toEqual({ kind: 'unload' })
    expect(runtime.status('acme.notes')).toBe('stopped')
  })

  it('ignores malformed messages and messages from a replaced process', async () => {
    const { runtime, processes } = setup()
    runtime.sync([plugin()])
    const first = processes[0]
    first.emit({ kind: 'call', id: 'x' })
    first.emit('garbage')
    runtime.sync([plugin({ canonicalMainPath: '/plugins/notes/v2.js' })])
    first.emit({ kind: 'ready' })
    expect(runtime.status('acme.notes')).toBe('starting')
  })
})

describe('plugin writes, approvals and view calls', () => {
  function withServices(mode: 'ask' | 'auto' | 'open', approveAnswer = true) {
    const calls: string[] = []
    const approvals: string[] = []
    let projectPath: string | null = '/work/shop'
    const audit: PluginAuditEntry[] = []
    const runtime = new PluginRuntime({
      spawn: () => new FakeProcess(),
      context: () => ({ projectPath, permissionMode: mode }),
      storage: { get: () => undefined, set: () => undefined },
      toast: () => undefined,
      openView: () => undefined,
      audit: (entry) => audit.push(entry),
      onChange: () => undefined,
      approve: async (request) => {
        approvals.push(request.title)
        return approveAnswer
      },
      services: {
        fs: {
          list: async () => ({ entries: [], truncated: false }),
          stat: async () => ({ kind: 'file', size: 1, modified: '' }),
          readText: async (_project, path) => ({ text: `read ${path}` }),
          writeText: async (project, path) => {
            calls.push(`write ${project} ${path}`)
          }
        },
        git: {
          status: async () => ({ branch: 'main', ahead: 0, behind: 0, files: [] }),
          diff: async () => ({ patch: '' }),
          log: async () => ({ commits: [] }),
          stage: async (_project, paths) => {
            calls.push(`stage ${paths.join(',')}`)
          },
          unstage: async () => undefined,
          discard: async (_project, paths) => {
            calls.push(`discard ${paths.join(',')}`)
          },
          commit: async () => ({ hash: 'abc' })
        }
      }
    })
    const view = {
      pluginId: 'acme.git',
      name: 'Git',
      granted: new Set(['ui.view', 'fs.read', 'fs.write', 'git.read', 'git.write']),
      commands: [],
      views: new Map()
    }
    return {
      runtime,
      view,
      calls,
      approvals,
      audit,
      switchProject: (next: string | null) => {
        projectPath = next
      }
    }
  }

  it('asks before every write at the ask level and honors a refusal', async () => {
    const { runtime, view, calls, approvals } = withServices('ask', false)
    await expect(
      runtime.callFromView(view, 'fs.writeText', { path: 'a.md', content: 'x' })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(approvals).toEqual(['写入 a.md'])
    expect(calls).toEqual([])
  })

  it('auto approves routine writes but still asks before discarding', async () => {
    const { runtime, view, calls, approvals } = withServices('auto')
    await runtime.callFromView(view, 'fs.writeText', { path: 'a.md', content: 'x' })
    await runtime.callFromView(view, 'git.stage', { paths: ['a.md'] })
    expect(approvals).toEqual([])
    await runtime.callFromView(view, 'git.discard', { paths: ['a.md'] })
    expect(approvals).toEqual(['丢弃 1 个文件的未暂存改动'])
    expect(calls).toEqual(['write /work/shop a.md', 'stage a.md', 'discard a.md'])
  })

  it('never asks at full access', async () => {
    const { runtime, view, approvals } = withServices('open')
    await runtime.callFromView(view, 'git.discard', { paths: ['a.md'] })
    await runtime.callFromView(view, 'git.commit', { message: 'x' })
    expect(approvals).toEqual([])
  })

  it('cancels a write when the project changes during approval', async () => {
    const setup = withServices('ask')
    const approve = setup.runtime['dependencies'].approve!
    setup.runtime['dependencies'].approve = async (request) => {
      setup.switchProject('/work/other')
      return approve(request)
    }
    await expect(
      setup.runtime.callFromView(setup.view, 'fs.writeText', { path: 'a.md', content: 'x' })
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(setup.calls).toEqual([])
  })

  it('lets views read but not register commands, rejects paths outside the project, and audits', async () => {
    const { runtime, view, audit } = withServices('open')
    await expect(runtime.callFromView(view, 'fs.readText', { path: 'src/a.ts' })).resolves.toEqual({
      text: 'read src/a.ts'
    })
    await expect(
      runtime.callFromView(view, 'commands.register', { id: 'x' })
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED'
    })
    await expect(
      runtime.callFromView(view, 'fs.readText', { path: '../etc/passwd' })
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
    await expect(
      runtime.callFromView({ ...view, granted: new Set(['ui.view']) }, 'fs.readText', { path: 'a' })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(audit.map(({ method, outcome }) => `${method}:${outcome}`)).toEqual([
      'fs.readText:ok',
      'commands.register:UNSUPPORTED',
      'fs.readText:INVALID_ARGUMENT',
      'fs.readText:PERMISSION_DENIED'
    ])
  })
})
