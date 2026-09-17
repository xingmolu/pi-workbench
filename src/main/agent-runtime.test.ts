import { expect, it } from 'vitest'
import { AGENT_ENGINE, type AgentSnapshot, type HostCommand } from '../shared/contracts'
import type { AgentRuntime, AgentRuntimeSessionOptions } from './agent-runtime'
import { SessionWorkerPool } from './session-worker-pool'

function snapshot(path: string | null): AgentSnapshot {
  return {
    sessionId: path,
    generation: 1,
    revision: 1,
    ready: true,
    engine: AGENT_ENGINE,
    agentDir: '/agent',
    project: { path: '/project', name: 'project' },
    sessions: [],
    activeSessionPath: path,
    nodes: [],
    accounts: [],
    models: [],
    activeProvider: null,
    activeModel: null,
    modelAvailability: 'available',
    composeBlockReason: null,
    busy: false,
    status: 'idle',
    approvals: [],
    followUp: [],
    queuedCount: 0,
    permissionMode: 'ask',
    metrics: { turns: 0, steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    login: { phase: 'idle' },
    loginPrompt: null
  }
}

it('drives resident session orchestration through AgentRuntime without process knowledge', async () => {
  const created: AgentRuntimeSessionOptions[] = []
  const commands: HostCommand[] = []
  let disposed = false
  const runtime: AgentRuntime = {
    async createSession(options) {
      created.push(options)
      return {
        async request(command) {
          commands.push(command)
          if (command.type === 'project:navigate')
            return { kind: 'snapshot', snapshot: snapshot(command.sessionPath ?? null) }
          return { kind: 'ack', sessionId: '/a', generation: 1, revision: 1 }
        },
        async dispose() {
          disposed = true
        }
      }
    }
  }

  const pool = new SessionWorkerPool({
    runtime,
    canonicalize: async path => path
  })
  const opened = await pool.open({ cwd: '/project', path: '/a' })

  expect(created).toHaveLength(1)
  expect(created[0].cwd).toBe('/project')
  expect(commands[0]).toMatchObject({ type: 'project:navigate', sessionPath: '/a' })
  await expect(pool.request(opened.scope, { type: 'prompt:abort' })).resolves.toMatchObject({
    kind: 'ack'
  })

  await pool.shutdown()
  expect(disposed).toBe(true)
})
