import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  accountHome,
  activeConnection,
  connectionEnvironment,
  connections,
  newConnectionId,
  prepareAccountHome,
  removeAccountHome
} from './connections'
import type { ClaudeStorage } from './storage'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function storage(): Promise<ClaudeStorage> {
  const root = await mkdtemp(join(tmpdir(), 'claude-connections-'))
  roots.push(root)
  const paths = {
    root,
    config: join(root, 'config'),
    sessions: join(root, 'sessions'),
    cache: join(root, 'cache')
  }
  await mkdir(paths.config)
  return paths
}

const config = {
  email: 'me@example.com',
  plan: 'Max',
  accounts: [{ id: 'claude-a1b2c3', email: 'work@example.com', plan: 'Team' }],
  apis: [{ id: 'claude-api-d4e5f6', apiKey: 'gateway-key', baseUrl: 'https://llm.corp.test' }]
}

it('lists the default login, each extra account and each API connection', () => {
  expect(connections(config)).toEqual([
    { id: 'anthropic', kind: 'default', email: 'me@example.com', plan: 'Max' },
    { id: 'claude-a1b2c3', kind: 'account', email: 'work@example.com', plan: 'Team' },
    { id: 'claude-api-d4e5f6', kind: 'api', baseUrl: 'https://llm.corp.test' }
  ])
  expect(activeConnection({ ...config, active: 'claude-a1b2c3' })).toBe('claude-a1b2c3')
  // A removed or unknown connection falls back to the default home.
  expect(activeConnection({ ...config, active: 'claude-gone99' })).toBe('anthropic')
  expect(newConnectionId('account')).toMatch(/^claude-[a-z0-9]{8}$/)
  expect(newConnectionId('api')).toMatch(/^claude-api-[a-z0-9]{8}$/)
})

it('gives each connection only its own home and secrets', async () => {
  const paths = await storage()
  const parent = { PATH: '/bin', ANTHROPIC_API_KEY: 'inherited', CLAUDE_CONFIG_DIR: '/home' }
  const account = connectionEnvironment(paths, config, 'claude-a1b2c3', parent)
  expect(account.CLAUDE_CONFIG_DIR).toBe(accountHome(paths, 'claude-a1b2c3'))
  expect(account.ANTHROPIC_API_KEY).toBeUndefined()
  const api = connectionEnvironment(paths, config, 'claude-api-d4e5f6', parent)
  expect(api).toMatchObject({
    CLAUDE_CONFIG_DIR: paths.config,
    ANTHROPIC_API_KEY: 'gateway-key',
    ANTHROPIC_BASE_URL: 'https://llm.corp.test'
  })
  const fallback = connectionEnvironment(paths, config, 'anthropic', parent)
  expect(fallback.CLAUDE_CONFIG_DIR).toBe(paths.config)
  expect(fallback.ANTHROPIC_API_KEY).toBeUndefined()
  expect(() => connectionEnvironment(paths, config, 'claude-nope00', parent)).toThrow('Unknown')
  expect(() => accountHome(paths, '../escape')).toThrow('Invalid')
})

it('shares transcripts between account homes and never deletes them with an account', async () => {
  const paths = await storage()
  const home = await prepareAccountHome(paths, 'claude-a1b2c3')
  await prepareAccountHome(paths, 'claude-a1b2c3')
  expect((await lstat(join(home, 'projects'))).isSymbolicLink()).toBe(true)
  await writeFile(join(home, 'projects', 'session.jsonl'), 'transcript')
  expect(await readFile(join(paths.config, 'projects', 'session.jsonl'), 'utf8')).toBe('transcript')
  await removeAccountHome(paths, 'claude-a1b2c3')
  await expect(lstat(home)).rejects.toThrow()
  expect(await readFile(join(paths.config, 'projects', 'session.jsonl'), 'utf8')).toBe('transcript')
})
