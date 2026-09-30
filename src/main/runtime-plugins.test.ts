import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSnapshot, HostCommand, HostEvent, HostResult } from '../shared/contracts'
import { agentRuntimeManifestSchema, type AgentRuntimeManifest } from '../shared/agent-runtime'
import { agentSnapshotSchema } from '../shared/schemas'
import { EMPTY_SNAPSHOT } from '../renderer/src/store/pi-store'
import {
  AgentRuntimeProviderRegistry,
  type AgentRuntimePlugin,
  type RuntimePluginSessionOptions
} from './agent-runtime'
import { HostRejectedError } from './host-response-broker'
import { SessionWorkerPool } from './session-worker-pool'
import { SessionWorkerSupervisor } from './session-worker-supervisor'
import { BackgroundSessionService } from './background-session-service'
import { runtimeStoragePaths } from './runtime-storage'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function registry(defaultProviderId = 'alpha') {
  const dataRoot = await mkdtemp(join(tmpdir(), 'desktop-runtimes-'))
  roots.push(dataRoot)
  return { dataRoot, runtimes: new AgentRuntimeProviderRegistry({ dataRoot, defaultProviderId }) }
}

function fixture(id: string, overrides: Partial<AgentRuntimeManifest> = {}) {
  const controllers: Array<{
    options: RuntimePluginSessionOptions
    request: ReturnType<typeof vi.fn<(command: HostCommand) => Promise<HostResult>>>
    dispose: ReturnType<typeof vi.fn<() => Promise<void>>>
    publish(event: HostEvent): void
    snapshot(): AgentSnapshot
  }> = []
  const plugin: AgentRuntimePlugin = {
    manifest: {
      apiVersion: 1,
      id,
      label: id,
      engine: `sdk-${id}`,
      features: ['session-resume', 'model-selection', 'auth-login', 'queue', 'project-catalog'],
      authentication: ['browser'],
      subagents: 'desktop',
      toolDelivery: 'mcp',
      skills: 'none',
      storage: 'desktop',
      ...overrides
    },
    createSession: vi.fn(async (options) => {
      let state: AgentSnapshot = {
        ...EMPTY_SNAPSHOT,
        engine: `sdk-${id}`,
        ready: true,
        agentDir: options.storage.config,
        project: { path: options.cwd, name: 'project' },
        activeProvider: 'same-model-vendor',
        activeModel: `${id}-model`,
        modelAvailability: 'available',
        composeBlockReason: null,
        models: [
          {
            provider: 'same-model-vendor',
            id: `${id}-model`,
            name: id,
            contextWindow: 100_000,
            reasoning: false
          }
        ],
        accounts: [
          { id, name: id, connected: false, authType: 'oauth', subscription: true, alias: false }
        ]
      }
      const emit = () =>
        options.onEvent({ type: 'event', event: 'snapshot', data: structuredClone(state) })
      const request = vi.fn(async (command: HostCommand): Promise<HostResult> => {
        if (command.type === 'project:navigate') {
          state = {
            ...state,
            sessionId: options.workerId,
            generation: 1,
            revision: 1,
            activeSessionPath:
              command.sessionPath ?? join(options.storage.sessions, `${options.workerId}.json`)
          }
          return { kind: 'snapshot', snapshot: structuredClone(state) }
        }
        if (
          command.type === 'state:get' ||
          command.type === 'bootstrap' ||
          command.type === 'runtime:refresh'
        )
          return { kind: 'snapshot', snapshot: structuredClone(state) }
        if (command.type === 'model:set')
          state = { ...state, activeProvider: command.providerId, activeModel: command.modelId }
        if (command.type === 'account:login')
          state = {
            ...state,
            accounts: state.accounts.map((account) => ({ ...account, connected: true }))
          }
        if (command.type === 'permission:set') state = { ...state, permissionMode: command.mode }
        if (command.type === 'prompt:send')
          state = {
            ...state,
            nodes: [
              ...state.nodes,
              { type: 'user', id: 'user', canonicalEntryId: 'user-entry', text: command.text },
              {
                type: 'assistant',
                id: 'reply',
                canonicalEntryId: 'reply-entry',
                markdown: `${id} result`
              }
            ]
          }
        state = { ...state, revision: state.revision + 1 }
        emit()
        return {
          kind: 'ack',
          sessionId: state.sessionId,
          generation: state.generation,
          revision: state.revision
        }
      })
      const dispose = vi.fn(async () => {})
      controllers.push({
        options,
        request,
        dispose,
        publish: options.onEvent,
        snapshot: () => structuredClone(state)
      })
      return { request, dispose }
    })
  }
  return { plugin, controllers }
}

describe('runtime plugins through the desktop orchestration interface', () => {
  it('runs two adapters with independent models, login state, storage and foreground selection', async () => {
    const { runtimes, dataRoot } = await registry()
    const alpha = fixture('alpha'),
      beta = fixture('beta')
    runtimes.registerPlugin(alpha.plugin)
    runtimes.registerPlugin(beta.plugin)
    const supervisor = new SessionWorkerSupervisor({
      runtime: runtimes,
      canonicalize: async (path) => path,
      publish: () => {},
      selected: () => {}
    })
    const a = await supervisor.open({ cwd: '/project' }, null)
    const b = await supervisor.open(
      { cwd: '/project', runtimeId: 'beta' },
      supervisor.selectedScope
    )
    expect(a.runtime?.id).toBe('alpha')
    expect(b.runtime?.id).toBe('beta')
    expect(a.models[0].provider).toBe(b.models[0].provider)
    expect(a.models[0].id).not.toBe(b.models[0].id)
    expect(a.agentDir).toBe(runtimeStoragePaths(dataRoot, 'alpha').config)
    expect(b.agentDir).toBe(runtimeStoragePaths(dataRoot, 'beta').config)
    expect(agentSnapshotSchema.parse(b).engine).toBe('sdk-beta')
    await supervisor.request({ type: 'account:login', providerId: 'beta', method: 'browser' })
    expect(supervisor.getSnapshot(b.desktopScope!.workerId)?.accounts[0].connected).toBe(true)
    expect(supervisor.getSnapshot(a.desktopScope!.workerId)?.accounts[0].connected).toBe(false)
    supervisor.select(a.desktopScope!.workerId)
    await supervisor.request({
      type: 'model:set',
      providerId: 'same-model-vendor',
      modelId: 'alpha-other'
    })
    expect(supervisor.getSnapshot(b.desktopScope!.workerId)?.activeModel).toBe('beta-model')
    expect(supervisor.getLiveSummaries().map((row) => row.runtimeId)).toEqual(['alpha', 'beta'])
    for (const paths of [
      runtimeStoragePaths(dataRoot, 'alpha'),
      runtimeStoragePaths(dataRoot, 'beta')
    ]) {
      expect((await stat(paths.sessions)).isDirectory()).toBe(true)
      expect(paths.sessions).not.toContain('/.claude/')
    }
    await supervisor.shutdown()
  })

  it('rejects unsupported commands and foreign CLI sessions before calling the SDK', async () => {
    const { runtimes } = await registry()
    const alpha = fixture('alpha')
    runtimes.registerPlugin(alpha.plugin)
    const session = await runtimes.createSession({
      workerId: 'a',
      cwd: '/project',
      onEvent: () => {},
      onExit: () => {}
    })
    const request = alpha.controllers[0].request
    for (const command of [
      { type: 'endpoint:list' },
      { type: 'account:login', providerId: 'alpha', method: 'device_code' },
      {
        type: 'project:navigate',
        cwd: '/project',
        sessionId: null,
        generation: 0,
        sessionPath: '/home/.claude/projects/cli.json'
      },
      {
        type: 'prompt:send',
        text: 'image',
        sessionId: 'a',
        generation: 1,
        images: [{ mimeType: 'image/png', data: 'x' }]
      }
    ] satisfies HostCommand[])
      await expect(session.request(command)).rejects.toBeInstanceOf(HostRejectedError)
    expect(request).not.toHaveBeenCalled()
    await session.dispose()
  })

  it('does not evict a saved worker for an unknown runtime or reinterpret its transcript with another SDK', async () => {
    const { runtimes } = await registry()
    const alpha = fixture('alpha'),
      beta = fixture('beta')
    runtimes.registerPlugin(alpha.plugin)
    runtimes.registerPlugin(beta.plugin)
    const pool = new SessionWorkerPool({
      runtime: runtimes,
      capacity: 1,
      canonicalize: async (path) => path
    })
    const a = await pool.openBackground({ cwd: '/project' })
    pool.updateSafety(a.workerId, { receipts: 'settled', unsaved: false })
    await expect(pool.open({ cwd: '/project', runtimeId: 'missing' })).rejects.toThrow(
      /not registered/
    )
    await expect(
      pool.open({ cwd: '/project', path: a.snapshot.activeSessionPath!, runtimeId: 'beta' })
    ).rejects.toThrow(/another runtime/)
    expect(alpha.controllers[0].dispose).not.toHaveBeenCalled()
    expect(beta.plugin.createSession).not.toHaveBeenCalled()
    await pool.shutdown()
  })

  it('preserves normalized streaming events and runtime identity independently of native metadata', async () => {
    const { runtimes } = await registry()
    const alpha = fixture('alpha')
    runtimes.registerPlugin(alpha.plugin)
    const pool = new SessionWorkerPool({ runtime: runtimes, canonicalize: async (path) => path })
    const opened = await pool.open({ cwd: '/project' })
    const current = pool.getSnapshot(opened.scope.workerId)!
    alpha.controllers[0].publish({
      type: 'event',
      event: 'patch',
      data: {
        sessionId: current.sessionId,
        generation: current.generation,
        baseRevision: current.revision,
        revision: current.revision + 1,
        nodeUpserts: [{ id: 'stream', type: 'assistant', markdown: 'partial', streaming: true }],
        removedNodeIds: [],
        meta: { busy: true, status: 'running' }
      }
    })
    expect(pool.getSnapshot(opened.scope.workerId)).toMatchObject({
      runtime: { id: 'alpha' },
      engine: 'sdk-alpha',
      busy: true,
      nodes: [{ markdown: 'partial', streaming: true }]
    })
    await pool.shutdown()
  })

  it('inherits the parent runtime for desktop subagents instead of falling back to the default', async () => {
    const { runtimes } = await registry()
    const alpha = fixture('alpha'),
      beta = fixture('beta')
    runtimes.registerPlugin(alpha.plugin)
    runtimes.registerPlugin(beta.plugin)
    const supervisor = new SessionWorkerSupervisor({
      runtime: runtimes,
      canonicalize: async (path) => path,
      publish: () => {},
      selected: () => {}
    })
    const parent = await supervisor.open({ cwd: '/project', runtimeId: 'beta' }, null)
    const service = new BackgroundSessionService(supervisor)
    const child = await service.spawnFromParent(
      {
        workerId: parent.desktopScope!.workerId,
        sessionId: parent.sessionId!,
        generation: parent.generation
      },
      'review'
    )
    expect(supervisor.getSnapshot(child.workerId)?.runtime?.id).toBe('beta')
    expect(service.result(child)).toMatchObject({ outcome: 'ready', markdown: 'beta result' })
    expect(alpha.plugin.createSession).not.toHaveBeenCalled()
    expect(supervisor.selectedScope).toEqual(parent.desktopScope)
    await supervisor.shutdown()
  })

  it('supports a minimal desktop adapter without requiring optional model-selection commands', async () => {
    const { runtimes } = await registry()
    const alpha = fixture('alpha', { features: [], authentication: [] })
    runtimes.registerPlugin(alpha.plugin)
    const supervisor = new SessionWorkerSupervisor({
      runtime: runtimes,
      canonicalize: async (path) => path,
      publish: () => {},
      selected: () => {}
    })
    const parent = await supervisor.open({ cwd: '/project' }, null)
    const service = new BackgroundSessionService(supervisor)
    const child = await service.spawnFromParent(
      {
        workerId: parent.desktopScope!.workerId,
        sessionId: parent.sessionId!,
        generation: parent.generation
      },
      'review'
    )
    expect(service.result(child)).toMatchObject({ outcome: 'ready', markdown: 'alpha result' })
    for (const controller of alpha.controllers) {
      expect(controller.request.mock.calls.map(([command]) => command.type)).not.toContain(
        'model:set'
      )
    }
    await supervisor.shutdown()
  })

  it('leaves native subagent ownership to its adapter', async () => {
    const { runtimes } = await registry()
    const alpha = fixture('alpha', { subagents: 'native' })
    runtimes.registerPlugin(alpha.plugin)
    const supervisor = new SessionWorkerSupervisor({
      runtime: runtimes,
      canonicalize: async (path) => path,
      publish: () => {},
      selected: () => {}
    })
    const parent = await supervisor.open({ cwd: '/project' }, null)
    await expect(
      new BackgroundSessionService(supervisor).spawnFromParent(
        {
          workerId: parent.desktopScope!.workerId,
          sessionId: parent.sessionId!,
          generation: parent.generation
        },
        'review'
      )
    ).rejects.toThrow(/不支持桌面派发/)
    expect(alpha.controllers).toHaveLength(1)
    await supervisor.shutdown()
  })

  it('isolates invalid adapter events and disposes once without crashing the desktop callback', async () => {
    const { runtimes } = await registry()
    const alpha = fixture('alpha')
    runtimes.registerPlugin(alpha.plugin)
    const events = vi.fn(),
      exit = vi.fn()
    const session = await runtimes.createSession({
      workerId: 'a',
      cwd: '/project',
      onEvent: events,
      onExit: exit
    })
    const native = alpha.controllers[0]
    expect(() =>
      native.publish({
        type: 'event',
        event: 'snapshot',
        data: { ...native.snapshot(), revision: -1 }
      })
    ).not.toThrow()
    expect(exit).toHaveBeenCalledOnce()
    expect(events).not.toHaveBeenCalled()
    await session.dispose()
    await session.dispose()
    expect(native.dispose).toHaveBeenCalledOnce()
    native.publish({ type: 'event', event: 'snapshot', data: native.snapshot() })
    expect(events).not.toHaveBeenCalled()
  })

  it('fences late SDK events and successful-looking responses after the adapter exits', async () => {
    const { runtimes } = await registry()
    const alpha = fixture('alpha')
    runtimes.registerPlugin(alpha.plugin)
    const events = vi.fn(),
      exit = vi.fn()
    const session = await runtimes.createSession({
      workerId: 'a',
      cwd: '/project',
      onEvent: events,
      onExit: exit
    })
    const native = alpha.controllers[0]
    native.request.mockImplementationOnce(async () => {
      native.options.onExit(new Error('SDK crashed'))
      native.publish({ type: 'event', event: 'snapshot', data: native.snapshot() })
      return { kind: 'snapshot', snapshot: native.snapshot() }
    })
    await expect(session.request({ type: 'state:get' })).rejects.toThrow('SDK crashed')
    expect(events).not.toHaveBeenCalled()
    native.options.onExit(new Error('duplicate exit'))
    expect(exit).toHaveBeenCalledOnce()
    await session.dispose()
    expect(native.dispose).toHaveBeenCalledOnce()
  })

  it('protects manifests against caller mutation and rejects invalid plugin identifiers/protocol versions', async () => {
    const { runtimes, dataRoot } = await registry()
    const implicitDefault = new AgentRuntimeProviderRegistry({ dataRoot })
    implicitDefault.registerPlugin(fixture('gamma').plugin)
    expect(implicitDefault.resolveProviderId()).toBe('gamma')
    const alpha = fixture('alpha')
    runtimes.registerPlugin(alpha.plugin)
    alpha.plugin.manifest.features.push('custom-endpoints')
    const catalog = runtimes.manifests()
    catalog[0].features.push('custom-endpoints')
    const session = await runtimes
      .get('alpha')
      .createSession({ workerId: 'a', cwd: '/project', onEvent: () => {}, onExit: () => {} })
    await expect(session.request({ type: 'endpoint:list' })).rejects.toThrow(/不支持/)
    expect(() => runtimes.registerPlugin(fixture('../escape').plugin)).toThrow()
    expect(() => runtimes.registerPlugin(fixture('alpha').plugin)).toThrow(/already registered/)
    expect(() =>
      agentRuntimeManifestSchema.parse({ ...alpha.plugin.manifest, apiVersion: 2 })
    ).toThrow()
    expect(() => runtimeStoragePaths('/data', '../escape')).toThrow()
    await session.dispose()
  })
})
