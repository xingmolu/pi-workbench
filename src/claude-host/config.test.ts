import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeEnvironment, readConfig, saveConfig } from './config'
import { ClaudeSessionStore, type ClaudeStorage } from './storage'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function storage(): Promise<ClaudeStorage> {
  const root = await mkdtemp(join(tmpdir(), 'claude-reference-'))
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
it('isolates provider credentials and executable configuration from the parent process', async () => {
  const paths = await storage()
  const env = claudeEnvironment(
    paths,
    { apiKey: 'app-key', baseUrl: 'http://localhost:1234' },
    {
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'home-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'home-token',
      CLAUDE_CONFIG_DIR: '/home/claude',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_API_KEY_HELPER: 'cat secret',
      CLAUDECODE: '1'
    }
  )
  expect(env).toMatchObject({
    PATH: '/bin',
    ANTHROPIC_API_KEY: 'app-key',
    CLAUDE_CONFIG_DIR: paths.config
  })
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
  expect(env.CLAUDECODE).toBeUndefined()
  await saveConfig(paths, { apiKey: 'app-key', model: 'actual-model' })
  expect(await readConfig(paths)).toEqual({ apiKey: 'app-key', model: 'actual-model' })
})
it('persists public references with metadata only and fences paths across runtimes', async () => {
  const paths = await storage()
  const store = new ClaudeSessionStore(paths)
  const nativeSessionId = 'ca920e16-7a0a-4e3a-a7ca-48a4c17ce708'
  const path = await store.save({
    version: 1,
    runtimeId: 'claude',
    nativeSessionId,
    cwd: '/project',
    created: new Date().toISOString()
  })
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
    nativeSessionId,
    runtimeId: 'claude'
  })
  await expect(store.read(join(paths.root, 'foreign.json'))).rejects.toThrow('another runtime')
  await expect(
    store.save({
      version: 1,
      runtimeId: 'claude',
      nativeSessionId,
      cwd: '/project',
      created: new Date().toISOString(),
      nodes: []
    } as never)
  ).rejects.toThrow()
})
it('gives a bearer-token service its key as ANTHROPIC_AUTH_TOKEN only', async () => {
  const paths = await storage()
  const env = claudeEnvironment(
    paths,
    { apiKey: 'gw-key', baseUrl: 'https://gw.example.com', bearer: true },
    { PATH: '/bin', ANTHROPIC_API_KEY: 'home-key' }
  )
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe('gw-key')
  expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  expect(env.ANTHROPIC_BASE_URL).toBe('https://gw.example.com')
})
