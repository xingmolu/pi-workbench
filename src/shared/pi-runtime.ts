import { AGENT_ENGINE } from './contracts'
import type { AgentRuntimeManifest } from './agent-runtime'

/** Pi-specific knowledge lives with its adapter declaration, not the desktop protocol. */
export const PI_RUNTIME_MANIFEST: AgentRuntimeManifest = {
  apiVersion: 1,
  id: 'pi',
  label: 'Pi',
  engine: AGENT_ENGINE,
  features: [
    'session-resume',
    'session-fork',
    'session-rename',
    'session-edit',
    'session-search',
    'project-catalog',
    'model-selection',
    'thinking',
    'images',
    'auth-login',
    'account-aliases',
    'account-quota',
    'custom-endpoints',
    'mcp',
    'skills',
    'attachments',
    'checkpoints',
    'message-feedback',
    'permission-rules',
    'queue',
    'host-browser',
    'host-computer-use'
  ],
  authentication: ['api_key', 'browser', 'device_code'],
  subagents: 'desktop',
  toolDelivery: 'native',
  skills: 'native',
  storage: 'desktop',
  accountProviders: [{ platform: 'chatgpt', label: 'ChatGPT', login: ['browser', 'device_code'] }],
  credentials: {
    accounts: ['chatgpt'],
    apis: ['openai-completions', 'openai-responses', 'anthropic-messages']
  }
}
