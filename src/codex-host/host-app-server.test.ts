import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
    await rm(root, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
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
  return { make, cwd, fixture, credentialRequests, events }
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
    expect(credentialRequests.slice(before)).toMatchObject([
      { kind: 'chatgpt-token', accountId: 'openai-codex', reason: 'start' }
    ])
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
})
