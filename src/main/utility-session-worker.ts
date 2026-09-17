import { utilityProcess } from 'electron'
import type {
  AgentRuntime,
  AgentRuntimeSession,
  AgentRuntimeSessionOptions
} from './agent-runtime'
import { HostResponseBroker } from './host-response-broker'

export type UtilityProcessAgentRuntimeOptions = {
  script: string
  env?: Record<string, string | undefined>
  onMessage(
    worker: AgentRuntimeSessionOptions,
    message: unknown,
    reply: (message: unknown) => void
  ): boolean
}

/**
 * Concrete local AgentRuntime backed by one Electron utilityProcess per session.
 * Session orchestration does not depend on Electron or Pi-specific process details.
 */
export class UtilityProcessAgentRuntime implements AgentRuntime {
  constructor(private readonly options: UtilityProcessAgentRuntimeOptions) {}

  createSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeSession> {
    return createUtilitySessionWorker({
      ...options,
      script: this.options.script,
      ...(this.options.env ? { env: this.options.env } : {}),
      onMessage: (message, reply) => this.options.onMessage(options, message, reply)
    })
  }
}

/** One broker and one readiness promise per child; disposal waits for actual exit. */
export async function createUtilitySessionWorker(
  options: AgentRuntimeSessionOptions & {
    script: string
    env?: Record<string, string | undefined>
    onMessage(message: unknown, reply: (message: unknown) => void): boolean
  }
): Promise<AgentRuntimeSession> {
  const broker = new HostResponseBroker()
  const child = utilityProcess.fork(options.script, [], {
    serviceName: `Pi Session Host ${options.workerId}`,
    stdio: 'pipe',
    ...(options.env ? { env: options.env } : {})
  })
  let exited = false
  let disposing = false
  let resolveExit!: () => void
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  const ready = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
    child.once('exit', () => reject(new Error('会话进程启动失败')))
  })
  child.stdout?.resume()
  child.stderr?.resume()
  child.on('error', () => {
    child.kill()
  })
  child.on('message', (message) => {
    if (
      options.onMessage(message, (reply) => {
        if (!exited) child.postMessage(reply)
      })
    )
      return
    const event = broker.accept(message)
    if (event) options.onEvent(event)
  })
  child.once('exit', (code) => {
    exited = true
    const error = new Error(`会话进程已退出（code ${code}）`)
    broker.rejectAll(error)
    resolveExit()
    options.onExit(disposing ? undefined : error)
  })
  const request: AgentRuntimeSession['request'] = async (command, expectedIdentity) => {
    await ready
    if (exited) throw new Error('会话进程已退出')
    return broker.request(command, (request) => child.postMessage(request), expectedIdentity)
  }
  const dispose = async () => {
    if (exited) return
    disposing = true
    const timeout = setTimeout(() => child.kill(), 5000)
    try {
      await request({ type: 'runtime:shutdown' }).catch(() => {})
      if (!exited) child.kill()
      await exit
    } finally {
      clearTimeout(timeout)
    }
  }
  try {
    const initial = await request({ type: 'bootstrap' })
    if (
      initial.kind !== 'snapshot' ||
      initial.snapshot.sessionId !== null ||
      initial.snapshot.generation !== 0
    )
      throw new Error('会话进程启动状态无效')
    return { request, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
