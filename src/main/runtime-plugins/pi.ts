import type { AgentRuntimePlugin, AgentRuntimeSessionOptions } from '../agent-runtime'
import { UtilityProcessAgentRuntime } from '../utility-session-worker'
import { PI_RUNTIME_MANIFEST } from '../../shared/pi-runtime'

/** The bundled Pi SDK host is a plugin; the utility process is only its transport. */
export function createPiRuntimePlugin(options: {
  script: string
  env?: Record<string, string | undefined>
  onMessage(
    worker: AgentRuntimeSessionOptions,
    message: unknown,
    reply: (message: unknown) => void
  ): boolean
}): AgentRuntimePlugin {
  return {
    manifest: {
      ...PI_RUNTIME_MANIFEST,
      ...(options.env?.PI_DESKTOP_E2E === '1' ? { storage: 'legacy' as const } : {})
    },
    createSession: (session) =>
      new UtilityProcessAgentRuntime({
        ...options,
        env: {
          ...process.env,
          ...options.env,
          PI_DESKTOP_RUNTIME_STORAGE: JSON.stringify(session.storage)
        },
        provider: {
          id: PI_RUNTIME_MANIFEST.id,
          label: PI_RUNTIME_MANIFEST.label,
          residentSessions: true,
          hostCapabilities: true,
          toolDelivery: 'native',
          skills: 'native'
        }
      }).createSession(session)
  }
}
