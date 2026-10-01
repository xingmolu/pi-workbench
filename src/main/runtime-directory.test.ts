import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeDirectory } from './runtime-directory'
import { GlobalConfigurationGate } from './global-configuration-gate'
import { AgentRuntimeProviderRegistry, type RuntimePluginSessionOptions } from './agent-runtime'
import { createEmptyAgentSnapshot } from '../shared/initial-agent-snapshot'
import type { HostCommand, HostResult } from '../shared/contracts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup(
  scenario?: (id: string, command: HostCommand, path: string) => HostResult | Promise<HostResult>,
  onRequestFailure?: (id: string, command: HostCommand, error: unknown) => void
) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-directory-'))
  roots.push(root)
  const registry = new AgentRuntimeProviderRegistry({ dataRoot: root })
  const requests: Array<{ id: string; command: HostCommand }> = []
  const hosts: RuntimePluginSessionOptions[] = []
  const disposals = vi.fn()
  for (const id of ['claude', 'pi'])
    registry.registerPlugin({
      manifest: {
        apiVersion: 1,
        id,
        label: id,
        engine: id,
        features: ['project-catalog', 'session-search'],
        authentication: [],
        subagents: 'none',
        toolDelivery: 'none',
        skills: 'none',
        storage: 'desktop'
      },
      createSession: async (options) => {
        hosts.push(options)
        const path = join(options.storage.sessions, 'native-ref')
        return {
          dispose: async () => {
            disposals(id)
          },
          request: async (command) => {
            requests.push({ id, command })
            if (scenario) return scenario(id, command, path)
            if (command.type === 'project:catalog')
              return {
                kind: 'project-catalog',
                catalog: {
                  projects: [
                    {
                      path: '/project',
                      name: 'project',
                      sessions: [
                        {
                          id,
                          path,
                          title: id,
                          modified: '2026-09-30T00:00:00.000Z',
                          active: false,
                          messageCount: 1,
                          status: 'idle'
                        }
                      ],
                      totalSessions: 1,
                      nextOffset: null
                    }
                  ],
                  totalProjects: 1,
                  truncated: false
                }
              } satisfies HostResult
            if (command.type === 'session:search')
              return {
                kind: 'session-search',
                result: {
                  items: [
                    {
                      id,
                      cwd: '/project',
                      projectName: 'project',
                      title: id,
                      sessionPath: path,
                      modified: '2026-09-30T00:00:00.000Z'
                    }
                  ],
                  total: 1,
                  truncated: false,
                  skippedDirectories: 0,
                  skippedEntries: 0
                }
              } satisfies HostResult
            return {
              kind: 'snapshot',
              snapshot: { ...createEmptyAgentSnapshot(id, options.storage.config), ready: true }
            } satisfies HostResult
          }
        }
      }
    })
  const events = vi.fn(),
    exits = vi.fn()
  const directory = new RuntimeDirectory({
    registry,
    cwd: '/project',
    onEvent: events,
    onExit: exits,
    onRequestFailure,
    onCapability: () => false
  })
  return { directory, requests, hosts, disposals, events, exits }
}

it('creates a cold selected configuration host once, and never creates a chat for discovery', async () => {
  const { directory, hosts } = await setup()
  await Promise.all([
    directory.request('claude', { type: 'state:get' }),
    directory.request('claude', { type: 'state:get' })
  ])
  expect(hosts).toHaveLength(1)
  expect(hosts[0]).toMatchObject({
    runtimeId: 'claude',
    role: 'configuration',
    workerId: 'configuration:claude'
  })
  expect(directory.snapshot('claude')?.sessionId).toBeNull()
  expect(directory.snapshot('pi')).toBeNull()
  await directory.shutdown()
})

it('merges same-project catalogs and retains the runtime of unloaded session paths and search results', async () => {
  const { directory } = await setup()
  const catalog = await directory.query({ type: 'project:catalog' })
  if (catalog.kind !== 'project-catalog') throw new Error('Wrong result')
  expect(catalog.catalog.projects).toHaveLength(1)
  expect(catalog.catalog.projects[0].sessions.map((item) => item.runtimeId).sort()).toEqual([
    'claude',
    'pi'
  ])
  for (const session of catalog.catalog.projects[0].sessions)
    expect(directory.runtimeForPath(session.path)).toBe(session.runtimeId)
  const search = await directory.query({ type: 'session:search', query: '', limit: 10 })
  if (search.kind !== 'session-search') throw new Error('Wrong result')
  expect(search.result.items.map((item) => item.runtimeId).sort()).toEqual(['claude', 'pi'])
  expect(search.result.total).toBe(2)
  await directory.shutdown()
})

it('keeps the other engines in the sidebar when one engine cannot answer', async () => {
  const { directory } = await setup((id, _command, path) => {
    if (id === 'claude') throw new Error('Claude executable is missing')
    return {
      kind: 'project-catalog',
      catalog: {
        projects: [
          {
            path: '/project',
            name: 'project',
            sessions: [
              {
                id,
                path,
                title: id,
                modified: '2026-09-30T00:00:00.000Z',
                active: false,
                messageCount: 1,
                status: 'idle'
              }
            ],
            totalSessions: 1,
            nextOffset: null
          }
        ],
        totalProjects: 1,
        truncated: false
      }
    } satisfies HostResult
  })
  const catalog = await directory.query({ type: 'project:catalog' })
  if (catalog.kind !== 'project-catalog') throw new Error('Wrong result')
  expect(catalog.catalog.projects[0].sessions.map((item) => item.runtimeId)).toEqual(['pi'])
  await directory.shutdown()
})

it('reports a failure when no engine can list projects', async () => {
  const { directory } = await setup(() => {
    throw new Error('nothing starts')
  })
  await expect(directory.query({ type: 'project:catalog' })).rejects.toThrow('nothing starts')
  await directory.shutdown()
})

it('refreshes one engine and restarts an exited host without replacing another engine', async () => {
  const { directory, hosts, requests, disposals } = await setup()
  await directory.request('pi', { type: 'state:get' })
  await directory.request('claude', { type: 'state:get' })
  await directory.request('claude', { type: 'runtime:refresh' })
  expect(
    requests.filter((item) => item.command.type === 'runtime:refresh').map((item) => item.id)
  ).toEqual(['claude'])
  hosts[1].onExit(new Error('gone'))
  expect(directory.snapshot('claude')).toBeNull()
  expect(directory.snapshot('pi')?.runtime?.id).toBe('pi')
  await directory.request('claude', { type: 'state:get' })
  expect(hosts).toHaveLength(3)
  await directory.shutdown()
  expect(disposals).toHaveBeenCalledWith('pi')
  expect(disposals).toHaveBeenCalledWith('claude')
})

it('preserves older pinned sessions ahead of newer unpinned results before global truncation', async () => {
  let pinned = ''
  const { directory } = await setup((id, command, path) => {
    if (id === 'claude') pinned = path
    if (command.type === 'session:search')
      return {
        kind: 'session-search',
        result: {
          items: [
            {
              id,
              cwd: '/project',
              projectName: 'project',
              title: id,
              sessionPath: path,
              modified: id === 'claude' ? '2020-01-01T00:00:00.000Z' : '2026-01-01T00:00:00.000Z'
            }
          ],
          total: 1,
          truncated: false,
          skippedDirectories: 0,
          skippedEntries: 0
        }
      }
    throw new Error('Unexpected fixture command')
  })
  await directory.query({ type: 'session:search', query: '', limit: 10 })
  const result = await directory.query({
    type: 'session:search',
    query: '',
    limit: 1,
    navigation: {
      version: 1,
      revision: 0,
      projects: {},
      sessions: { [pinned]: { cwd: '/project', pinnedAt: 1 } },
      layout: {}
    }
  })
  if (result.kind !== 'session-search') throw new Error('Wrong result')
  expect(result.result.items[0].runtimeId).toBe('claude')
  await directory.shutdown()
})

it('caps merged project catalogs and keeps source totals when search is truncated', async () => {
  const { directory } = await setup((id, command) => {
    if (command.type === 'project:catalog')
      return {
        kind: 'project-catalog',
        catalog: {
          projects: Array.from({ length: 100 }, (_, index) => ({
            path: `/${id}/${index}`,
            name: String(index),
            sessions: [],
            totalSessions: 0,
            nextOffset: null
          })),
          totalProjects: 150,
          truncated: true
        }
      }
    if (command.type === 'project:search')
      return {
        kind: 'project-search',
        result: {
          items: Array.from({ length: command.limit }, (_, index) => ({
            cwd: `/${id}/${index}`,
            projectName: String(index),
            available: true
          })),
          total: 250,
          truncated: true,
          skippedDirectories: 0,
          skippedEntries: 0
        }
      }
    throw new Error('Unexpected fixture command')
  })
  const catalog = await directory.query({ type: 'project:catalog' })
  if (catalog.kind !== 'project-catalog') throw new Error('Wrong result')
  expect(catalog.catalog.projects).toHaveLength(100)
  expect(catalog.catalog.totalProjects).toBeGreaterThanOrEqual(150)
  expect(catalog.catalog.truncated).toBe(true)
  const search = await directory.query({ type: 'project:search', query: '', limit: 50 })
  if (search.kind !== 'project-search') throw new Error('Wrong result')
  expect(search.result.total).toBe(250)
  expect(search.result.totalIsLowerBound).toBe(true)
  expect(search.result.items).toHaveLength(50)
  await directory.shutdown()
})

it('keeps projects pinned in another runtime before the global catalog and search limits', async () => {
  const { directory } = await setup((id, command) => {
    const paths = Array.from({ length: 100 }, (_, index) => `/${id}/${index}`)
    if (command.type === 'project:catalog')
      return {
        kind: 'project-catalog',
        catalog: {
          projects: paths.map((path) => ({
            path,
            name: path,
            sessions: [],
            totalSessions: 0,
            nextOffset: null
          })),
          totalProjects: 100,
          truncated: false
        }
      }
    if (command.type === 'project:search')
      return {
        kind: 'project-search',
        result: {
          items: [id === 'pi' ? '/pi/99' : '/claude/0'].map((cwd) => ({
            cwd,
            projectName: cwd,
            available: true
          })),
          total: 100,
          truncated: false,
          skippedDirectories: 0,
          skippedEntries: 0
        }
      }
    throw new Error('Unexpected fixture command')
  })
  const navigation = {
    version: 1 as const,
    revision: 0,
    projects: { '/pi/99': { pinnedAt: 1 } },
    sessions: {},
    layout: {}
  }
  const catalog = await directory.query({ type: 'project:catalog', navigation })
  if (catalog.kind !== 'project-catalog') throw new Error('Wrong result')
  expect(catalog.catalog.projects[0].path).toBe('/pi/99')
  const search = await directory.query({ type: 'project:search', query: '', limit: 1, navigation })
  if (search.kind !== 'project-search') throw new Error('Wrong result')
  expect(search.result.items[0].cwd).toBe('/pi/99')
  await directory.shutdown()
})

it('does not mark a terminated configuration host uncertain after its rejected request resumes', async () => {
  const gate = new GlobalConfigurationGate(() => true)
  let rejectRefresh: (error: Error) => void = () => {
    throw new Error('Refresh did not start')
  }
  const { directory, hosts } = await setup(
    (id, command) => {
      if (command.type === 'runtime:refresh')
        return new Promise((_, reject) => {
          rejectRefresh = reject
        })
      return { kind: 'snapshot', snapshot: createEmptyAgentSnapshot(id, '') }
    },
    (id, _command, error) => gate.recordFailure(`configuration:${id}`, error)
  )
  await directory.request('pi', { type: 'state:get' })
  const refresh = gate.run(() => directory.request('pi', { type: 'runtime:refresh' }))
  const assertion = expect(refresh).rejects.toThrow('Host exited')
  await Promise.resolve()
  await Promise.resolve()
  const error = new Error('Host exited')
  rejectRefresh(error)
  hosts[0].onExit(error)
  gate.ownerExited('configuration:pi')
  await assertion
  expect(gate.busy).toBe(false)
  await expect(
    gate.run(() => directory.request('pi', { type: 'state:get' }))
  ).resolves.toMatchObject({ kind: 'snapshot' })
  expect(hosts).toHaveLength(2)
  await directory.shutdown()
})
