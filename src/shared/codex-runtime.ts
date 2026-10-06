import type { AgentRuntimeManifest } from './agent-runtime'

/**
 * OpenAI's Codex CLI driven through `codex app-server`. It signs in with the ChatGPT accounts
 * Pi already holds (each account is granted to Codex by the user once), so it declares no
 * login of its own.
 */
export const CODEX_RUNTIME_MANIFEST: AgentRuntimeManifest = {
  apiVersion: 1,
  id: 'codex',
  label: 'Codex',
  engine: '@openai/codex',
  features: [
    'session-resume',
    'session-fork',
    'session-rename',
    'project-catalog',
    'model-selection',
    'thinking',
    'images',
    'skills',
    'mcp',
    'auth-login'
  ],
  authentication: ['external', 'api_key'],
  subagents: 'native',
  toolDelivery: 'native',
  skills: 'native',
  storage: 'desktop',
  // Gateways that speak the Responses API; Codex no longer supports Chat Completions.
  credentials: { accounts: ['chatgpt'], apis: ['openai-responses'] }
}
