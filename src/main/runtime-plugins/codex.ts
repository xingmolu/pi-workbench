import type { AgentRuntimePlugin, AgentRuntimeSessionOptions } from '../agent-runtime'
import { UtilityProcessAgentRuntime } from '../utility-session-worker'
import { CODEX_RUNTIME_MANIFEST } from '../../shared/codex-runtime'

/** Codex app-server adapter; the CLI is downloaded on demand and Electron owns the worker. */
export function createCodexRuntimePlugin(options: {
  script: string
  env?: Record<string, string | undefined>
  /** The Codex CLI to run; looked up for every new host so a fresh download is used. */
  executable?: () => string | undefined
  onMessage(
    worker: AgentRuntimeSessionOptions,
    message: unknown,
    reply: (message: unknown) => void
  ): boolean
}): AgentRuntimePlugin {
  return {
    manifest: CODEX_RUNTIME_MANIFEST,
    createSession: (sessionOptions) =>
      new UtilityProcessAgentRuntime({
        ...options,
        env: {
          ...process.env,
          ...options.env,
          PI_DESKTOP_CODEX_EXECUTABLE: options.executable?.() ?? '',
          PI_DESKTOP_RUNTIME_STORAGE: JSON.stringify(sessionOptions.storage)
        },
        provider: {
          id: CODEX_RUNTIME_MANIFEST.id,
          label: CODEX_RUNTIME_MANIFEST.label,
          residentSessions: true,
          hostCapabilities: true,
          toolDelivery: 'native',
          skills: 'native'
        }
      }).createSession(sessionOptions)
  }
}
