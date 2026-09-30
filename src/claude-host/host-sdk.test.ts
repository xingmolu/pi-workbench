import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeHost } from './host'
import { saveConfig } from './config'
import { createClaudeHttpFixture } from './sdk-fixture'
import { hostMessageSchema, hostResultSchema } from '../shared/schemas'
import { pluginAgentRequestSchema } from '../shared/plugin-agent'
import type { PluginAgentContributions } from '../shared/plugin-agent'
import type { ClaudeStorage } from './storage'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function setup(
  delayMs = 0,
  childDelayMs = 0,
  contributions: PluginAgentContributions = { tools: [], skillPaths: [], mcpServers: {} },
  streamDelayMs = 0
) {
  const root = await mkdtemp(join(tmpdir(), 'claude-runtime-sdk-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const storage: ClaudeStorage = {
    root,
    config: join(root, 'config'),
    sessions: join(root, 'sessions'),
    cache: join(root, 'cache')
  }
  const cwd = join(root, 'project')
  await Promise.all(
    [cwd, storage.config, storage.sessions, storage.cache].map((path) => mkdir(path))
  )
  const fixture = await createClaudeHttpFixture({ cwd, delayMs, childDelayMs, streamDelayMs })
  cleanup.push(fixture.close)
  await saveConfig(storage, { apiKey: 'fixture-key', baseUrl: fixture.baseUrl })
  const events: unknown[] = []
  let host!: ClaudeHost
  host = new ClaudeHost({
    storage,
    post(message) {
      if (typeof message === 'object' && message && 'type' in message) {
        if (message.type === 'plugin-agent-contributions-request') {
          const request = message as Record<string, unknown>
          queueMicrotask(() =>
            host.accept({
              type: 'plugin-agent-contributions',
              requestId: request.requestId,
              contributions
            })
          )
        } else if (message.type === 'plugin-tool-request') {
          const request = pluginAgentRequestSchema.parse(message)
          if (request.type !== 'plugin-tool-request') throw new Error('Plugin request missing')
          queueMicrotask(() =>
            host.accept({
              type: 'plugin-tool-response',
              requestId: request.requestId,
              ok: true,
              text: 'Desktop plugin result'
            })
          )
        } else if (message.type === 'capability-request') {
          const request = message as Record<string, unknown>
          queueMicrotask(() =>
            host.accept({
              type: 'capability-response',
              capability: 'browser',
              requestId: request.requestId,
              ok: true,
              data: {
                kind: 'state',
                state: {
                  available: true,
                  visible: false,
                  pages: [],
                  activePageId: null,
                  controller: 'idle'
                }
              }
            })
          )
        } else if (message.type === 'project-mutation') {
          const request = message as Record<string, unknown>
          if (request.action === 'acquire')
            queueMicrotask(() =>
              host.accept({
                type: 'project-mutation-response',
                requestId: request.requestId,
                ok: true
              })
            )
        } else {
          expect(hostMessageSchema.safeParse(message).success).toBe(true)
          events.push(message)
        }
      }
    }
  })
  cleanup.push(() => host.handle({ type: 'runtime:shutdown' }))
  return { host, fixture, cwd, storage, events }
}
async function waitFor(check: () => boolean, timeout = 20_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for SDK event')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('Claude official SDK runtime', () => {
  it('boots without a paid prompt, admits asynchronously, persists native history and supports rename/fork/resume', async () => {
    const { host, fixture, cwd, storage } = await setup(120)
    const boot = await host.handle({ type: 'bootstrap' })
    expect(hostResultSchema.safeParse(boot).success).toBe(true)
    expect(host.getState()).toMatchObject({ sessionId: null, generation: 0, ready: true })
    expect(host.getState().models.length).toBeGreaterThan(0)
    expect(fixture.requests.filter((request) => request.path.includes('/messages'))).toHaveLength(0)
    await host.handle({ type: 'project:open', cwd })
    const identity = {
      sessionId: host.getState().sessionId!,
      generation: host.getState().generation
    }
    const admitted = await host.handle({ type: 'prompt:send', ...identity, text: 'hello fixture' })
    expect(admitted.kind).toBe('ack')
    expect(host.getState().busy).toBe(true)
    await waitFor(() => !host.getState().busy)
    expect(host.getState().error).toBeUndefined()
    expect(host.getState().models.some((model) => model.id === host.getState().activeModel)).toBe(
      true
    )
    expect(host.getState().nodes.filter((node) => node.type === 'assistant')).toHaveLength(1)
    const user = host.getState().nodes.find((node) => node.type === 'user')!
    const path = host.getState().activeSessionPath!
    const reference = JSON.parse(await readFile(path, 'utf8'))
    expect(reference.nativeSessionId).toBe(identity.sessionId)
    expect(Object.keys(reference)).toEqual(
      expect.arrayContaining(['version', 'runtimeId', 'nativeSessionId', 'cwd', 'created'])
    )
    expect(JSON.stringify(reference)).not.toContain('hello fixture')
    expect(await readdir(join(storage.config, 'projects'))).not.toHaveLength(0)
    await host.handle({ type: 'session:rename', ...identity, name: 'Native fixture renamed' })
    expect(host.getState().sessions.find((session) => session.active)?.title).toBe(
      'Native fixture renamed'
    )
    await host.handle({ type: 'session:new' })
    await host.handle({ type: 'session:open', path })
    expect(
      host
        .getState()
        .nodes.some(
          (node) => node.type === 'assistant' && node.markdown.includes('Claude fixture reply')
        )
    ).toBe(true)
    await host.handle({
      type: 'prompt:send',
      text: 'resume fixture',
      sessionId: host.getState().sessionId!,
      generation: host.getState().generation
    })
    await waitFor(() => !host.getState().busy)
    const forkIdentity = {
      sessionId: host.getState().sessionId!,
      generation: host.getState().generation
    }
    const fork = await host.handle({ type: 'session:fork', ...forkIdentity, entryId: user.id })
    expect(fork.kind).toBe('session-fork')
    expect(host.getState().sessionId).not.toBe(identity.sessionId)
    expect(host.getState().sessions.find((session) => session.active)?.parentSessionPath).toBe(path)
  }, 45_000)

  it('routes real Write permissions to desktop approval and mutation leases', async () => {
    const { host, cwd } = await setup()
    await host.handle({ type: 'bootstrap' })
    await host.handle({ type: 'project:open', cwd })
    await host.handle({
      type: 'prompt:send',
      text: 'write fixture',
      sessionId: host.getState().sessionId!,
      generation: host.getState().generation
    })
    await waitFor(() => host.getState().approvals.length > 0 || !host.getState().busy)
    expect(host.getState().approvals[0]?.toolName).toBe('Write')
    const approval = host.getState().approvals[0]!
    await host.handle({ type: 'permission:respond', approvalId: approval.id, allow: true })
    await waitFor(() => !host.getState().busy)
    expect(await readFile(join(cwd, 'fixture.txt'), 'utf8')).toBe('Native SDK wrote this.\n')
    expect(
      host
        .getState()
        .nodes.some(
          (node) => node.type === 'tool' && node.name === 'Write' && node.status === 'success'
        )
    ).toBe(true)
  }, 45_000)

  it('denies a real native Write and keeps the project unchanged', async () => {
    const { host, cwd } = await setup()
    await host.handle({ type: 'bootstrap' })
    await host.handle({ type: 'project:open', cwd })
    await host.handle({
      type: 'prompt:send',
      text: 'write fixture',
      sessionId: host.getState().sessionId!,
      generation: host.getState().generation
    })
    await waitFor(() => host.getState().approvals.length > 0)
    await host.handle({
      type: 'permission:respond',
      approvalId: host.getState().approvals[0].id,
      allow: false
    })
    await waitFor(() => !host.getState().busy)
    await expect(readFile(join(cwd, 'fixture.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(host.getState().approvals).toHaveLength(0)
    expect(
      host
        .getState()
        .nodes.some(
          (node) => node.type === 'tool' && node.name === 'Write' && node.status === 'blocked'
        )
    ).toBe(true)
  }, 45_000)

  it('stops while native Write approval is pending and rejects a late approval', async () => {
    const { host, cwd, fixture } = await setup()
    await host.handle({ type: 'bootstrap' })
    await host.handle({ type: 'project:open', cwd })
    await host.handle({
      type: 'prompt:send',
      text: 'write fixture',
      sessionId: host.getState().sessionId!,
      generation: host.getState().generation
    })
    await waitFor(() => host.getState().approvals.length > 0)
    const approval = host.getState().approvals[0].id
    await host.handle({ type: 'prompt:abort' })
    await expect(
      host.handle({ type: 'permission:respond', approvalId: approval, allow: true })
    ).rejects.toThrow('expired')
    await expect(readFile(join(cwd, 'fixture.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(host.getState()).toMatchObject({ busy: false, status: 'stopped', approvals: [] })
    const count = fixture.requests.length
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(fixture.requests).toHaveLength(count)
  }, 45_000)

  it('separates real native subagent content and inspects the SDK child transcript', async () => {
    const { host, cwd } = await setup()
    await host.handle({ type: 'bootstrap' })
    await host.handle({ type: 'project:open', cwd })
    const identity = {
      sessionId: host.getState().sessionId!,
      generation: host.getState().generation
    }
    await host.handle({ type: 'permission:set', mode: 'open' })
    await host.handle({ type: 'prompt:send', text: 'spawn fixture', ...identity })
    await waitFor(() => !host.getState().busy)
    expect(host.getState().error).toBeUndefined()
    expect(
      host
        .getState()
        .nodes.filter((node) => node.type === 'assistant')
        .every((node) => node.type !== 'assistant' || !node.markdown.includes('Private child'))
    ).toBe(true)
    const task = host
      .getState()
      .nodes.flatMap((node) => (node.type === 'tool' ? (node.subagent?.children ?? []) : []))[0]
    expect(task).toBeDefined()
    const inspection = await host.handle({
      type: 'subagent:inspect',
      taskId: task!.id,
      ...identity
    })
    expect(inspection.kind).toBe('subagent-inspection')
    if (inspection.kind !== 'subagent-inspection') throw new Error('Inspection result missing')
    expect(
      inspection.snapshot.nodes.some(
        (node) => node.type === 'assistant' && node.markdown.includes('Private child fixture reply')
      )
    ).toBe(true)
    expect(host.getState().sessionId).toBe(identity.sessionId)
    const savedPath = host.getState().activeSessionPath!
    await host.handle({ type: 'session:new' })
    await host.handle({ type: 'session:open', path: savedPath })
    const resumedIdentity = {
      sessionId: host.getState().sessionId!,
      generation: host.getState().generation
    }
    const resumedTask = host
      .getState()
      .nodes.flatMap((node) => (node.type === 'tool' ? (node.subagent?.children ?? []) : []))
      .find((child) => child.id === task!.id)
    expect(resumedTask).toBeDefined()
    expect(resumedTask).toMatchObject({
      title: 'Inspect fixture child',
      prompt: 'child fixture'
    })
    expect(
      host
        .getState()
        .nodes.filter((node) => node.type === 'user')
        .map((node) => node.text)
    ).toEqual(['spawn fixture'])
    const resumedInspection = await host.handle({
      type: 'subagent:inspect',
      taskId: task!.id,
      ...resumedIdentity
    })
    expect(resumedInspection.kind).toBe('subagent-inspection')
    if (resumedInspection.kind === 'subagent-inspection')
      expect(
        resumedInspection.snapshot.nodes.some(
          (node) =>
            node.type === 'assistant' && node.markdown.includes('Private child fixture reply')
        )
      ).toBe(true)
  }, 45_000)

  it('inspects a native child during its streaming HTTP response without disrupting final history', async () => {
    const { host, cwd, fixture } = await setup(
      0,
      0,
      { tools: [], skillPaths: [], mcpServers: {} },
      60
    )
    await host.handle({ type: 'bootstrap' })
    await host.handle({ type: 'project:open', cwd })
    const identity = {
      sessionId: host.getState().sessionId!,
      generation: host.getState().generation
    }
    await host.handle({ type: 'permission:set', mode: 'open' })
    await host.handle({ type: 'prompt:send', text: 'spawn fixture', ...identity })
    const tasks = () =>
      host
        .getState()
        .nodes.flatMap((node) => (node.type === 'tool' ? (node.subagent?.children ?? []) : []))
    await waitFor(
      () =>
        tasks().some((task) => task.state === 'running') &&
        fixture.requests.some((request) =>
          JSON.stringify(request.body.messages ?? []).includes('"text":"child fixture"')
        )
    )
    const task = tasks().find((task) => task.state === 'running')!
    const partial = await host.handle({ type: 'subagent:inspect', taskId: task.id, ...identity })
    expect(partial.kind).toBe('subagent-inspection')
    await new Promise((resolve) => setTimeout(resolve, 100))
    await host.handle({ type: 'subagent:inspect', taskId: task.id, ...identity })
    await waitFor(() => !host.getState().busy)
    let complete = await host.handle({ type: 'subagent:inspect', taskId: task.id, ...identity })
    const inspectStarted = Date.now()
    while (
      complete.kind === 'subagent-inspection' &&
      !complete.snapshot.nodes.some((node) => node.type === 'assistant')
    ) {
      if (Date.now() - inspectStarted > 3000) break
      await new Promise((resolve) => setTimeout(resolve, 30))
      complete = await host.handle({ type: 'subagent:inspect', taskId: task.id, ...identity })
    }
    expect(complete.kind).toBe('subagent-inspection')
    if (complete.kind === 'subagent-inspection')
      expect(
        complete.snapshot.nodes.some(
          (node) => node.type === 'assistant' && node.markdown === 'Private child fixture reply.'
        )
      ).toBe(true)
  }, 45_000)

  it('cancels a real native background Agent with SDK stopTask', async () => {
    const { host, cwd } = await setup(0, 1500)
    await host.handle({ type: 'bootstrap' })
    await host.handle({ type: 'project:open', cwd })
    const identity = {
      sessionId: host.getState().sessionId!,
      generation: host.getState().generation
    }
    await host.handle({ type: 'permission:set', mode: 'open' })
    await host.handle({ type: 'prompt:send', text: 'spawn background fixture', ...identity })
    const tasks = () =>
      host
        .getState()
        .nodes.flatMap((node) => (node.type === 'tool' ? (node.subagent?.children ?? []) : []))
    await waitFor(() => tasks().some((task) => task.state === 'running'))
    const task = tasks().find((task) => task.state === 'running')!
    await host.handle({ type: 'session-task:cancel', taskId: task.id, ...identity })
    await waitFor(() => tasks().some((value) => value.id === task.id && value.state === 'stopped'))
    expect(tasks().find((value) => value.id === task.id)?.state).toBe('stopped')
  }, 45_000)

  it('invokes real SDK MCP browser and plugin contributions through the desktop protocols', async () => {
    const contributions: PluginAgentContributions = {
      tools: [
        {
          pluginId: 'fixture',
          pluginName: 'Fixture',
          name: 'echo',
          toolName: 'fixture_echo',
          title: 'Echo',
          description: 'Echo fixture input',
          readOnly: true,
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false
          }
        }
      ],
      skillPaths: [],
      mcpServers: {}
    }
    const { host, cwd } = await setup(0, 0, contributions)
    await host.handle({ type: 'bootstrap' })
    await host.handle({ type: 'project:open', cwd })
    const identity = {
      sessionId: host.getState().sessionId!,
      generation: host.getState().generation
    }
    await host.handle({ type: 'permission:set', mode: 'open' })
    await host.handle({ type: 'prompt:send', text: 'plugin fixture', ...identity })
    await waitFor(() => !host.getState().busy)
    expect(host.getState().error).toBeUndefined()
    expect(
      host
        .getState()
        .nodes.some(
          (node) => node.type === 'tool' && node.output?.includes('Desktop plugin result')
        )
    ).toBe(true)
    await host.handle({ type: 'prompt:send', text: 'browser fixture', ...identity })
    await waitFor(() => !host.getState().busy)
    expect(
      host
        .getState()
        .nodes.some(
          (node) =>
            node.type === 'tool' && node.name.includes('browser') && node.status === 'success'
        )
    ).toBe(true)
  }, 45_000)

  it('loads granted desktop skill directories as native SDK plugins', async () => {
    const { host, cwd, fixture, storage } = await setup()
    const skills = join(storage.cache, 'fixture-skills')
    await mkdir(join(skills, 'fixture-skill'), { recursive: true })
    await writeFile(
      join(skills, 'fixture-skill', 'SKILL.md'),
      '---\nname: fixture-skill\ndescription: Native contributed fixture skill\n---\nFixture skill instructions.'
    )
    // The production bridge receives these paths from main; this host uses the same handshake.
    const skillHost = new ClaudeHost({
      storage,
      post(message) {
        const request = pluginAgentRequestSchema.safeParse(message)
        if (request.success && request.data.type === 'plugin-agent-contributions-request')
          queueMicrotask(() =>
            skillHost.accept({
              type: 'plugin-agent-contributions',
              requestId: request.data.requestId,
              contributions: { tools: [], skillPaths: [skills], mcpServers: {} }
            })
          )
      }
    })
    cleanup.push(() => skillHost.handle({ type: 'runtime:shutdown' }))
    await host.handle({ type: 'runtime:shutdown' })
    await skillHost.handle({ type: 'bootstrap' })
    await skillHost.handle({ type: 'project:open', cwd })
    await skillHost.handle({
      type: 'prompt:send',
      text: 'hello fixture',
      sessionId: skillHost.getState().sessionId!,
      generation: skillHost.getState().generation
    })
    await waitFor(() => !skillHost.getState().busy)
    expect(JSON.stringify(fixture.requests.map((request) => request.body))).toContain(
      'Native contributed fixture skill'
    )
  }, 45_000)

  it('discovers models while disconnected and leaves the configuration host sessionless', async () => {
    const { host, fixture, storage } = await setup()
    await saveConfig(storage, {})
    await host.handle({ type: 'bootstrap' })
    expect(host.getState()).toMatchObject({ sessionId: null, generation: 0, ready: true })
    expect(host.getState().accounts[0]?.connected).toBe(false)
    expect(host.getState().models.length).toBeGreaterThan(0)
    expect(fixture.requests).toHaveLength(0)
    expect(await readdir(storage.sessions)).toHaveLength(0)
  }, 45_000)

  it('stops a delayed turn and never automatically sends another request', async () => {
    const { host, fixture, cwd } = await setup(1000)
    await host.handle({ type: 'bootstrap' })
    await host.handle({ type: 'project:open', cwd })
    await host.handle({
      type: 'prompt:send',
      text: 'slow fixture',
      sessionId: host.getState().sessionId!,
      generation: host.getState().generation
    })
    await waitFor(() => fixture.requests.some((request) => request.path.includes('/messages')))
    await host.handle({ type: 'prompt:abort' })
    const count = fixture.requests.length
    await new Promise((resolve) => setTimeout(resolve, 1300))
    expect(fixture.requests).toHaveLength(count)
    expect(host.getState()).toMatchObject({ busy: false, status: 'stopped' })
  }, 45_000)
})
