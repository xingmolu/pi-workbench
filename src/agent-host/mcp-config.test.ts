import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { McpConfigStore } from './mcp-config'
import { mcpSaveSchema, mcpServerSchema } from '../shared/mcp'

const dirs: string[] = []
const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-mcp-config-'))
  dirs.push(dir)
  return new McpConfigStore(join(dir, 'mcp.json'))
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const identity = { sessionId: null, generation: 0 }
it('saves canonical user config privately, redacts secrets, requires exact consent and retains secrets on edit', async () => {
  const store = await setup()
  const revision = (await store.read()).revision
  await store.save({
    type: 'mcp:save',
    ...identity,
    id: 'fixture',
    create: true,
    revision,
    server: { command: 'node', args: ['server.js'], env: { API_KEY: 'fixture-sensitive' } },
    enabled: true
  })
  expect((await stat(store.path)).mode & 0o777).toBe(0o600)
  const view = await store.read()
  expect(view.servers[0]).toMatchObject({ enabled: true, envKeys: ['API_KEY'] })
  expect(JSON.stringify(view)).not.toContain('fixture-sensitive')
  expect((await store.enabled()).fixture.env?.API_KEY).toBe('fixture-sensitive')
  await store.save({
    type: 'mcp:save',
    ...identity,
    id: 'fixture',
    create: false,
    revision: view.revision,
    server: { command: 'node', args: ['updated.js'] },
    enabled: true
  })
  expect((await store.enabled()).fixture.env?.API_KEY).toBe('fixture-sensitive')
  await expect(
    store.save({ type: 'mcp:toggle', ...identity, id: 'fixture', revision, enabled: false })
  ).rejects.toThrow('变化')
})
it('never executes ambient/external-modified definitions until explicitly re-enabled', async () => {
  const store = await setup()
  await writeFile(
    store.path,
    JSON.stringify({ mcpServers: { fixture: { command: 'node' } }, unrelated: { keep: true } })
  )
  expect((await store.read()).servers[0].status).toBe('untrusted')
  expect(await store.enabled()).toEqual({})
  await store.save({
    type: 'mcp:toggle',
    ...identity,
    id: 'fixture',
    revision: (await store.read()).revision,
    enabled: true
  })
  const document = JSON.parse(await readFile(store.path, 'utf8'))
  expect(document.unrelated).toEqual({ keep: true })
  document.mcpServers.fixture.command = 'different-command'
  await writeFile(store.path, JSON.stringify(document))
  expect(await store.enabled()).toEqual({})
  expect((await store.read()).servers[0].status).toBe('untrusted')
})
it('preserves advanced configs/comments and refuses malformed or symlink targets', async () => {
  const store = await setup()
  await writeFile(
    store.path,
    '{ // keep comment\n"mcpServers":{"advanced":{"url":"https://example.com/mcp","oauth":true}}}'
  )
  expect((await store.read()).servers[0]).toMatchObject({ editable: false, enabled: false })
  await store.save({
    type: 'mcp:save',
    ...identity,
    id: 'new',
    create: true,
    revision: (await store.read()).revision,
    server: { command: 'node' },
    enabled: false
  })
  expect(await readFile(store.path, 'utf8')).toContain('// keep comment')
  await writeFile(store.path, '{bad')
  expect((await store.read()).writable).toBe(false)
  await rm(store.path)
  const target = join(dirs.at(-1)!, 'target.json')
  await writeFile(target, '{}')
  await symlink(target, store.path)
  expect((await store.read()).writable).toBe(false)
  expect(await readFile(target, 'utf8')).toBe('{}')
})
it('rejects mixed transports, unsafe URLs, duplicate definitions and malformed IPC', async () => {
  for (const value of [
    { command: 'node', url: 'https://example.com' },
    { url: 'http://remote.example/mcp' },
    { url: 'https://user:secret@example.com/mcp' },
    { url: 'https://example.com/mcp?key=secret' },
    { command: 'node', headers: { Authorization: 'secret' } }
  ])
    expect(mcpServerSchema.safeParse(value).success).toBe(false)
  expect(
    mcpSaveSchema.safeParse({
      type: 'mcp:save',
      id: 'x',
      server: { command: 'node' },
      enabled: true
    }).success
  ).toBe(false)
})
