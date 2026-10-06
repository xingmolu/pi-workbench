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

describe('manifest.json plugin API compatibility', () => {
  function compatSetup() {
    const opened: string[] = []
    const toasts: string[] = []
    const stored: Record<string, unknown> = { greeting: 'hi' }
    const processes: FakeProcess[] = []
    const runtime = new PluginRuntime({
      spawn: () => {
        const child = new FakeProcess()
        processes.push(child)
        return child
      },
      context: () => ({ projectPath: '/work/shop' }),
      storage: { get: () => undefined, set: () => undefined },
      toast: (_pluginId, message) => toasts.push(message),
      openView: (viewId) => opened.push(viewId),
      audit: () => undefined,
      onChange: () => undefined,
      settings: {
        get: () => ({ ...stored }),
        set: (_pluginId, values) => Object.assign(stored, values)
      },
      dataPath: async (pluginId) => `/data/${pluginId}`,
      appearance: () => 'light'
    })
    const view = plugin({
      granted: new Set(['ui.view', 'agent.tools']),
      agentTools: ['echo_text'],
      views: new Map([['panel', 'acme.notes.panel']])
    })
    return { runtime, processes, opened, toasts, stored, view }
  }

  it('offers panels, toasts, settings, workspace and appearance to views', async () => {
    const { runtime, opened, toasts, view } = compatSetup()
    await runtime.callFromView(view, 'ui.openPanel', { title: 'x' })
    await runtime.callFromView(view, 'ui.showToast', { message: 'from view' })
    await runtime.callFromView(view, 'ui.notify', { message: 'notified' })
    expect(opened).toEqual(['acme.notes.panel'])
    expect(toasts).toEqual(['from view', 'notified'])
    await expect(runtime.callFromView(view, 'plugin.getSettings', {})).resolves.toEqual({
      greeting: 'hi'
    })
    await expect(runtime.callFromView(view, 'workspace.get', {})).resolves.toEqual({
      path: '/work/shop',
      name: 'shop'
    })
    await expect(runtime.callFromView(view, 'app.getAppearance', {})).resolves.toEqual({
      base: 'light'
    })
    for (const method of ['plugin.setSettings', 'plugin.getDataPath', 'agent.unregisterTool'])
      await expect(runtime.callFromView(view, method, {})).rejects.toMatchObject({
        code: 'UNSUPPORTED'
      })
  })

  it('lets the process change settings, find its data path and unregister tools', async () => {
    const { runtime, processes, stored, view } = compatSetup()
    runtime.sync([view])
    const child = processes[0]
    child.emit({ kind: 'ready' })
    child.emit({
      kind: 'call',
      id: 1,
      method: 'plugin.setSettings',
      params: { values: { greeting: 'yo' } }
    })
    child.emit({ kind: 'call', id: 2, method: 'plugin.getDataPath', params: {} })
    child.emit({ kind: 'call', id: 3, method: 'agent.registerTool', params: { name: 'echo_text' } })
    child.emit({
      kind: 'call',
      id: 4,
      method: 'agent.unregisterTool',
      params: { name: 'echo_text' }
    })
    await flush()
    expect(stored.greeting).toBe('yo')
    expect(child.lastReply(2)).toMatchObject({ ok: true, value: '/data/acme.notes' })
    await expect(runtime.runTool('acme.notes', 'echo_text', {})).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })

  it("forwards channels the host does not implement to the plugin's onPanelInvoke", async () => {
    const { runtime, processes, view } = compatSetup()
    await expect(runtime.callFromView(view, 'notes.list', {})).rejects.toMatchObject({
      code: 'UNSUPPORTED'
    })
    runtime.sync([view])
    const child = processes[0]
    child.emit({ kind: 'ready' })
    const reply = runtime.callFromView(view, 'notes.list', { limit: 2 })
    const invoke = child.sent.findLast((message) => message.kind === 'invoke')
    expect(invoke).toMatchObject({ target: 'panel', name: 'notes.list', input: { limit: 2 } })
    child.emit({ kind: 'reply', id: (invoke as { id: number }).id, ok: true, value: ['a', 'b'] })
    await expect(reply).resolves.toEqual(['a', 'b'])
  })
})

describe('plugin agent tools', () => {
  const toolPlugin = (): RuntimePlugin =>
    plugin({ granted: new Set(['agent.tools']), agentTools: ['lookup', 'unbound'] })

  it('runs only declared, registered tools and returns their result as text', async () => {
    const { runtime, processes, audit } = setup()
    runtime.sync([toolPlugin()])
    const child = processes[0]
    child.emit({ kind: 'ready' })
    child.emit({ kind: 'call', id: 1, method: 'agent.registerTool', params: { name: 'lookup' } })
    child.emit({ kind: 'call', id: 2, method: 'agent.registerTool', params: { name: 'other' } })
    await flush()
    expect(child.lastReply(1)).toMatchObject({ ok: true })
    expect(child.lastReply(2)).toMatchObject({ code: 'INVALID_ARGUMENT' })

    await expect(runtime.runTool('acme.notes', 'unbound', {})).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
    const result = runtime.runTool('acme.notes', 'lookup', { q: 'tax' })
    const invoke = child.sent.findLast((message) => message.kind === 'invoke')
    expect(invoke).toMatchObject({ target: 'tool', name: 'lookup', input: { q: 'tax' } })
    child.emit({
      kind: 'reply',
      id: (invoke as { id: number }).id,
      ok: true,
      value: { content: [{ type: 'text', text: 'rate 0.1' }] }
    })
    await expect(result).resolves.toBe('rate 0.1')
    expect(audit.at(-1)).toEqual({ pluginId: 'acme.notes', method: 'tool:lookup', outcome: 'ok' })
  })

  it('rejects tools without the agent.tools grant, times out and honors cancellation', async () => {
    const { runtime, processes } = setup({ tool: 20 })
    runtime.sync([plugin({ agentTools: ['lookup'] })])
    processes[0].emit({ kind: 'ready' })
    await expect(runtime.runTool('acme.notes', 'lookup', {})).rejects.toMatchObject({
      code: 'PERMISSION_DENIED'
    })

    runtime.sync([toolPlugin()])
    const child = processes.at(-1)!
    child.emit({ kind: 'ready' })
    child.emit({ kind: 'call', id: 1, method: 'agent.registerTool', params: { name: 'lookup' } })
    await flush()
    await expect(runtime.runTool('acme.notes', 'lookup', {})).rejects.toMatchObject({
      code: 'TIMEOUT'
    })
    const controller = new AbortController()
    const cancelled = runtime.runTool('acme.notes', 'lookup', {}, controller.signal)
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('does not let views register tools', async () => {
    const { runtime } = setup()
    await expect(
      runtime.callFromView(
        { ...toolPlugin(), canonicalMainPath: undefined } as never,
        'agent.registerTool',
        { name: 'lookup' }
      )
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })
})

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

  it('enforces allowlist, parameters and granted permissions, and audits refusals', async () => {
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
          status: async () => ({ branch: 'main', upstream: null, ahead: 0, behind: 0, files: [] }),
          diff: async () => ({ patch: '' }),
          log: async () => ({ commits: [] }),
          stage: async (_project, paths) => {
            calls.push(`stage ${paths.join(',')}`)
          },
          unstage: async () => undefined,
          discard: async (_project, paths) => {
            calls.push(`discard ${paths.join(',')}`)
          },
          commit: async () => ({ hash: 'abc' }),
          pushPlan: async (project) => ({
            root: project,
            branch: 'main',
            head: 'f'.repeat(40),
            remote: 'origin',
            url: 'https://example.com/shop.git',
            remoteBranch: 'main',
            setUpstream: false,
            commits: [{ hash: 'f'.repeat(40), subject: 'ship it' }],
            moreCommits: 0
          }),
          push: async (plan) => {
            calls.push(`push ${plan.remote} ${plan.remoteBranch}`)
            return { remote: plan.remote, branch: plan.remoteBranch }
          },
          outgoing: async () => ({
            branch: 'main',
            base: 'origin/main',
            commits: [],
            moreCommits: 0,
            patch: ''
          })
        },
        forge: {
          repository: async () => ({
            provider: 'github',
            host: 'github.com',
            owner: 'acme',
            repo: 'shop',
            webUrl: 'https://github.com/acme/shop',
            signedIn: true,
            viewer: 'me'
          }),
          client: async () =>
            ({
              pull: async (number: number) => ({
                number,
                title: 'Add cart',
                headRef: 'cart',
                baseRef: 'main',
                url: `https://github.com/acme/shop/pull/${number}`,
                headSha: 'a'.repeat(40)
              }),
              merge: async (number: number, method: string, sha: string) => {
                calls.push(`merge ${number} ${method} ${sha.slice(0, 1)}`)
              },
              comment: async (number: number, body: string) => {
                calls.push(`comment ${number} ${body}`)
                return { url: 'https://github.com/c' }
              }
            }) as never
        }
      },
      chatDraft: (pluginId, text) => calls.push(`draft ${pluginId} ${text}`)
    })
    const view = {
      pluginId: 'acme.git',
      name: 'Git',
      granted: new Set([
        'ui.view',
        'fs.read',
        'fs.write',
        'git.read',
        'git.write',
        'git.push',
        'forge.read',
        'forge.write',
        'chat.draft'
      ]),
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

  it('always asks before pushing, even at full access, and shows what leaves the machine', async () => {
    const { runtime, view, calls, approvals } = withServices('open')
    const detail: string[] = []
    const approve = runtime['dependencies'].approve!
    runtime['dependencies'].approve = async (request) => {
      detail.push(request.detail)
      return approve(request)
    }
    await expect(runtime.callFromView(view, 'git.push', {})).resolves.toEqual({
      remote: 'origin',
      branch: 'main'
    })
    expect(approvals).toEqual(['推送 main 到 origin/main'])
    expect(detail[0]).toContain('https://example.com/shop.git')
    expect(detail[0]).toContain('fffffff ship it')
    expect(calls).toEqual(['push origin main'])
  })

  it('always asks before merging or commenting, and merges only the head the user saw', async () => {
    const { runtime, view, calls, approvals } = withServices('open')
    await expect(
      runtime.callFromView(view, 'forge.merge', {
        number: 7,
        method: 'squash',
        headSha: 'b'.repeat(40)
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(approvals).toEqual([])
    await runtime.callFromView(view, 'forge.merge', {
      number: 7,
      method: 'squash',
      headSha: 'a'.repeat(40)
    })
    await runtime.callFromView(view, 'forge.comment', { number: 7, body: 'Looks good' })
    expect(approvals).toEqual(['合并拉取请求 #7', '在拉取请求 #7 上发表评论'])
    expect(calls).toEqual(['merge 7 squash a', 'comment 7 Looks good'])
    await runtime.callFromView(view, 'chat.draft', { text: 'Review PR #7' })
    expect(calls.at(-1)).toBe('draft acme.git Review PR #7')
    await expect(
      runtime.callFromView({ ...view, granted: new Set(['ui.view']) }, 'forge.pulls', {})
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('does not merge when the merge is refused', async () => {
    const { runtime, view, calls } = withServices('open', false)
    await expect(
      runtime.callFromView(view, 'forge.merge', {
        number: 7,
        method: 'merge',
        headSha: 'a'.repeat(40)
      })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(calls).toEqual([])
  })

  it('does not push when the push is refused', async () => {
    const { runtime, view, calls } = withServices('open', false)
    await expect(runtime.callFromView(view, 'git.push', {})).rejects.toMatchObject({
      code: 'PERMISSION_DENIED'
    })
    expect(calls).toEqual([])
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

  it('lets views read but not register commands, rejects paths outside the project, and audits refusals and writes', async () => {
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
    await runtime.callFromView(view, 'git.commit', { message: 'x' })
    expect(audit.map(({ method, outcome }) => `${method}:${outcome}`)).toEqual([
      'commands.register:UNSUPPORTED',
      'fs.readText:INVALID_ARGUMENT',
      'fs.readText:PERMISSION_DENIED',
      'git.commit:ok'
    ])
  })
})
