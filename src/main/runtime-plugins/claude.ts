import type { AgentRuntimePlugin, AgentRuntimeSessionOptions } from '../agent-runtime'
import { UtilityProcessAgentRuntime } from '../utility-session-worker'
import { CLAUDE_RUNTIME_MANIFEST } from '../../shared/claude-runtime'

/** Trusted bundled SDK adapter; Electron owns transport and worker lifecycle. */
export function createClaudeRuntimePlugin(options: {
  script: string
  env?: Record<string, string | undefined>
  /** The Claude Code CLI to run; looked up for every new host so a fresh download is used. */
  executable?: () => string | undefined
  onMessage(
    worker: AgentRuntimeSessionOptions,
    message: unknown,
    reply: (message: unknown) => void
  ): boolean
}): AgentRuntimePlugin {
  return {
    manifest: CLAUDE_RUNTIME_MANIFEST,
    createSession: (sessionOptions) =>
      new UtilityProcessAgentRuntime({
        ...options,
        env: {
          ...process.env,
          ...options.env,
          PI_DESKTOP_CLAUDE_EXECUTABLE: options.executable?.() ?? '',
          PI_DESKTOP_RUNTIME_STORAGE: JSON.stringify(sessionOptions.storage)
        },
        provider: {
          id: CLAUDE_RUNTIME_MANIFEST.id,
          label: CLAUDE_RUNTIME_MANIFEST.label,
          residentSessions: true,
          hostCapabilities: true,
          toolDelivery: 'mcp',
          skills: 'native'
        }
      }).createSession(sessionOptions)
  }
}
