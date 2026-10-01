import type { AgentRuntimeManifest } from './agent-runtime'

export const CLAUDE_RUNTIME_MANIFEST: AgentRuntimeManifest = {
  apiVersion: 1,
  id: 'claude',
  label: 'Claude Code',
  engine: '@anthropic-ai/claude-agent-sdk',
  features: [
    'session-resume',
    'session-fork',
    'session-rename',
    'session-search',
    'project-catalog',
    'model-selection',
    'thinking',
    'images',
    'auth-login',
    'mcp',
    'host-browser',
    'host-computer-use'
  ],
  authentication: ['api_key', 'browser'],
  subagents: 'native',
  toolDelivery: 'mcp',
  skills: 'native',
  storage: 'desktop',
  accountProviders: [{ platform: 'claude', label: 'Claude', login: ['browser'] }],
  credentials: { accounts: ['claude'], apis: ['anthropic-messages'] }
}
