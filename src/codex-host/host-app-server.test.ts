import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexHost, CONFIGURED_CONNECTION } from './host'
import { createResponsesFixture } from './responses-fixture'
import type { AgentSnapshot, HostEvent } from '../shared/contracts'

/** These tests run the real Codex CLI; point PI_DESKTOP_CODEX_EXECUTABLE at one to enable. */
const executable = process.env.PI_DESKTOP_CODEX_EXECUTABLE
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

const jwt = (claims: Record<string, unknown>): string =>
  ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.')

async function waitFor(check: () => boolean, timeout = 20000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'codex-host-'))
  const cwd = await mkdtemp(join(tmpdir(), 'codex-project-'))
  const fixture = await createResponsesFixture()
  cleanup.push(async () => {
    await fixture.close()
    // Codex may still be syncing plugins into its home when the test ends.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  const storage = {
    root,
    config: join(root, 'config'),
    sessions: join(root, 'sessions'),
    cache: join(root, 'cache')
  }
  const credentialRequests: Record<string, unknown>[] = []
  const events: HostEvent[] = []
  const make = (): CodexHost => {
    const host: CodexHost = new CodexHost({
      storage,
      role: 'session',
      executable: executable!,
      config: fixture.config,
      restartDelayMs: 50,
      post: (message) => {
        const value = message as Record<string, unknown>
        if (value.type === 'credential:request') {
          credentialRequests.push(value)
          const data =
            value.kind === 'chatgpt-accounts'
              ? [{ id: 'openai-codex', email: 'robin@example.com', plan: 'Plus', granted: true }]
              : {
                  accessToken: jwt({
                    'https://api.openai.com/auth': {
                      chatgpt_account_id: 'acct-robin',
                      chatgpt_plan_type: 'plus'
                    }
                  }),
                  chatgptAccountId: 'acct-robin',
                  planType: 'plus'
                }
          setTimeout(() =>
            host.accept({ type: 'credential:response', requestId: value.requestId, ok: true, data })
          )
          return
        }
        events.push(message as HostEvent)
      }
    })
    cleanup.push(async () => {
      await host.handle({ type: 'runtime:shutdown' })
    })
    return host
  }
  return { make, cwd, fixture, credentialRequests, events, storage }
}

const send = async (host: CodexHost, text: string): Promise<void> => {
  const state = host.getState()
  await host.handle({
    type: 'prompt:send',
    sessionId: state.sessionId!,
    generation: state.generation,
    text
  })
}
const nodes = (state: AgentSnapshot, type: string) =>
  state.nodes.filter((node) => node.type === type)

describe.skipIf(!executable)('Codex app-server runtime', () => {
  it('chats, asks before running commands, resumes and lends the chosen ChatGPT account', async () => {
    const { make, cwd, fixture, credentialRequests } = await setup()
    const host = make()
    await host.handle({ type: 'bootstrap' })
    expect(host.getState()).toMatchObject({ ready: true })
    await host.handle({ type: 'project:open', cwd })
    const state = host.getState()
    expect(state.accounts.map((account) => account.id)).toEqual([
      CONFIGURED_CONNECTION,
      'openai-codex'
    ])
    expect(state.activeProvider).toBe(CONFIGURED_CONNECTION)
    expect(state.activeModel).toBe('fixture-model')
    expect(state.composeBlockReason).toBeNull()

    await send(host, 'hello codex')
    await waitFor(() => !host.getState().busy)
    expect(nodes(host.getState(), 'user')).toMatchObject([{ text: 'hello codex' }])
    expect(nodes(host.getState(), 'assistant')).toMatchObject([
      { markdown: 'Codex fixture reply.' }
    ])
    expect(host.getState().metrics.input).toBeGreaterThan(0)

    // Ask mode: the command waits for the desktop's approval.
    await send(host, 'please run command')
    await waitFor(() => host.getState().approvals.length === 1)
    const approval = host.getState().approvals[0]!
    expect(approval).toMatchObject({
      intent: 'terminal',
      title: 'echo fixture > made-by-codex.txt'
    })
    await host.handle({
      type: 'permission:respond',
      approvalId: approval.id,
      allow: true
    })
    await waitFor(() => !host.getState().busy)
    expect(await readFile(join(cwd, 'made-by-codex.txt'), 'utf8')).toBe('fixture\n')
    const tool = host.getState().nodes.find((node) => node.type === 'tool')
    expect(tool).toMatchObject({ status: 'success', intent: 'terminal' })

    await send(host, 'run command again')
    await waitFor(() => host.getState().approvals.length === 1)
    await host.handle({
      type: 'permission:respond',
      approvalId: host.getState().approvals[0]!.id,
      allow: false
    })
    await waitFor(() => !host.getState().busy)
    expect(
      host
        .getState()
        .nodes.filter((node) => node.type === 'tool')
        .at(-1)
    ).toMatchObject({
      status: 'blocked'
    })

    // Switching to a ChatGPT account asks the desktop for its token before the next turn.
    const path = host.getState().activeSessionPath!
    await host.handle({ type: 'model:set', providerId: 'openai-codex', modelId: 'fixture-model' })
    const before = credentialRequests.length
    await send(host, 'on the shared account')
    await waitFor(() => !host.getState().busy)
    const asked = credentialRequests.slice(before)
    expect(asked[0]).toMatchObject({
      kind: 'chatgpt-token',
      accountId: 'openai-codex',
      reason: 'start'
    })
    // With internet access Codex checks the (fake) token, is refused, and asks for a fresh one
    // through the same channel; offline it never does.
    expect(asked.slice(1).every((request) => request.reason === 'refresh')).toBe(true)
    expect(asked.every((request) => request.accountId === 'openai-codex')).toBe(true)
    expect(nodes(host.getState(), 'assistant').length).toBe(4)
    expect(host.getState().sessions[0]).toMatchObject({ path, title: 'hello codex' })

    // A fresh host reopens the chat from Codex's own transcript once this one has let go.
    await host.handle({ type: 'runtime:shutdown' })
    const reopened = make()
    await reopened.handle({ type: 'bootstrap' })
    await reopened.handle({ type: 'session:open', path })
    expect(
      nodes(reopened.getState(), 'user').map((node) => (node as { text: string }).text)
    ).toEqual(['hello codex', 'please run command', 'run command again', 'on the shared account'])
    expect(reopened.getState().activeProvider).toBe('openai-codex')
    expect(fixture.requests.length).toBeGreaterThanOrEqual(6)
    expect(existsSync(path)).toBe(true)
  }, 90000)

  it('forks at a turn and sends composer skills as Codex skill inputs', async () => {
    const { make, cwd, fixture, storage } = await setup()
    await mkdir(join(storage.config, 'skills', 'greet-user'), { recursive: true })
    await writeFile(
      join(storage.config, 'skills', 'greet-user', 'SKILL.md'),
      '---\nname: greet-user\ndescription: Greets the user warmly.\n---\n\nSAY-HELLO-MARKER\n'
    )
    const host = make()
    await host.handle({ type: 'bootstrap' })
    await host.handle({ type: 'project:open', cwd })
    await send(host, 'first turn')
    await waitFor(() => !host.getState().busy)
    await send(host, 'second turn')
    await waitFor(() => !host.getState().busy)
    const parent = host.getState().activeSessionPath!
    const first = nodes(host.getState(), 'user')[0] as { canonicalEntryId?: string }
    expect(first.canonicalEntryId).toBeTruthy()
    expect(host.getState().fork?.entryId).toBeTruthy()

    const state = host.getState()
    const forked = await host.handle({
      type: 'session:fork',
      sessionId: state.sessionId!,
      generation: state.generation,
      entryId: first.canonicalEntryId!
    })
    expect(forked.kind).toBe('session-fork')
    const userTexts = (): string[] =>
      nodes(host.getState(), 'user').map((node) => (node as { text: string }).text)
    expect(userTexts()).toEqual(['first turn'])
    expect(host.getState().activeSessionPath).not.toBe(parent)
    await send(host, 'on the fork')
    await waitFor(() => !host.getState().busy)
    expect(userTexts()).toEqual(['first turn', 'on the fork'])
    expect(host.getState().sessions.find((session) => session.active)?.parentSessionPath).toBe(
      parent
    )

    const now = host.getState()
    const catalog = await host.handle({
      type: 'skills:list',
      sessionId: now.sessionId!,
      generation: now.generation
    })
    const skill =
      catalog.kind === 'skills-list'
        ? catalog.catalog.skills.find((item) => item.name === 'greet-user')
        : undefined
    expect(skill).toMatchObject({ canInsert: true, scope: 'user' })
    await send(host, '/skill:greet-user please')
    await waitFor(() => !host.getState().busy)
    expect(JSON.stringify(fixture.requests.at(-1)?.input)).toContain('SAY-HELLO-MARKER')
  }, 90000)

  it('restarts a crashed app-server and carries on in the same thread', async () => {
    const { make, cwd } = await setup()
    const host = make()
    await host.handle({ type: 'bootstrap' })
    await host.handle({ type: 'project:open', cwd })
    await send(host, 'before the crash')
    await waitFor(() => !host.getState().busy)
    const path = host.getState().activeSessionPath

    const child = (host as unknown as { server: { child: { kill(signal: string): void } } }).server
      .child
    child.kill('SIGKILL')
    await waitFor(() => host.getState().error?.includes('Codex 已退出') === true)
    expect(nodes(host.getState(), 'error').length).toBe(1)
    await waitFor(() =>
      host.getState().nodes.some((node) => node.type === 'stopped' && /自动重启/.test(node.message))
    )
    expect(host.getState()).toMatchObject({ ready: true, activeSessionPath: path })
    expect(host.getState().error).toBeFalsy()

    await send(host, 'after the crash')
    await waitFor(() => !host.getState().busy)
    expect(nodes(host.getState(), 'assistant').length).toBe(2)
    expect(host.getState().activeSessionPath).toBe(path)
  }, 90000)

  it('adds, lists and turns off MCP servers in Codex config', async () => {
    const { make, cwd, storage } = await setup()
    const host = make()
    await host.handle({ type: 'bootstrap' })
    await host.handle({ type: 'project:open', cwd })
    const identity = () => ({
      sessionId: host.getState().sessionId,
      generation: host.getState().generation
    })
    const mcp = async (command: Record<string, unknown>) => {
      const result = await host.handle(command as never)
      if (result.kind !== 'mcp') throw new Error('expected an MCP result')
      return result.result
    }
    const empty = await mcp({ type: 'mcp:list' })
    expect(empty.servers).toEqual([])
    const saved = await mcp({
      type: 'mcp:save',
      ...identity(),
      revision: empty.revision,
      id: 'docs',
      server: { url: 'http://127.0.0.1:9/mcp', headers: { 'X-Team': 'pi' } },
      enabled: true,
      create: true
    })
    expect(saved).toMatchObject({ saved: true })
    expect(saved.servers).toMatchObject([
      {
        id: 'docs',
        transport: 'http',
        url: 'http://127.0.0.1:9/mcp',
        headerKeys: ['X-Team'],
        enabled: true
      }
    ])
    const toml = await readFile(join(storage.config, 'config.toml'), 'utf8')
    expect(toml).toContain('[mcp_servers.docs]')
    const off = await mcp({
      type: 'mcp:toggle',
      ...identity(),
      revision: saved.revision,
      id: 'docs',
      enabled: false
    })
    expect(off.servers[0]).toMatchObject({ id: 'docs', enabled: false, status: 'disabled' })
    await expect(
      mcp({
        type: 'mcp:toggle',
        ...identity(),
        revision: saved.revision,
        id: 'docs',
        enabled: true
      })
    ).rejects.toThrow('MCP 配置已变化')
  }, 90000)
})
