import { expect, it } from 'vitest'
import { searchProjects, searchSessions } from './session-search'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('matches a suffix in the full SDK title while keeping the returned title bounded', async () => {
  const result = await searchSessions({
    query: '尾部 needle',
    limit: 50,
    agentDir: '/agent',
    directories: async () => [],
    manager: {
      listAll: async () => [
        {
          id: 'long',
          path: '/agent/sessions/long.jsonl',
          cwd: '/project',
          name: '长'.repeat(240) + '尾部 NEEDLE',
          firstMessage: 'ignored',
          created: new Date(0),
          modified: new Date(0),
          messageCount: 1,
          allMessagesText: 'private'
        }
      ]
    }
  })
  expect(result.total).toBe(1)
  expect(result.items[0].title).toBe('长'.repeat(200))
})

it('matches Chinese and mixed-case titles beyond both catalog caps without returning transcript', async () => {
  const session = (cwd: string, index: number) => ({
    cwd,
    id: String(index),
    path: `/agent/sessions/${index}.jsonl`,
    created: new Date(0),
    modified: new Date(index * 1000),
    messageCount: 1,
    firstMessage: `title ${index}`,
    allMessagesText: 'private transcript'
  })
  const sessions = [
    ...Array.from({ length: 52 }, (_, index) => session('/a', index)),
    ...Array.from({ length: 101 }, (_, index) => session(`/project-${index}`, index + 100))
  ]
  sessions[0].firstMessage = '中文 Needle'
  sessions[sessions.length - 1].firstMessage = '中文 NEEDLE'
  const result = await searchSessions({
    query: '中文 needle',
    limit: 50,
    agentDir: '/agent',
    manager: { listAll: async () => sessions },
    directories: async () => [],
    normalize: async (path) => path
  })
  expect(result.items.map((item) => item.id)).toEqual(['200', '0'])
  expect(result.total).toBe(2)
  expect(result.truncated).toBe(false)
  expect(JSON.stringify(result)).not.toContain('private transcript')
  expect(result.items[0]).toEqual({
    id: '200',
    sessionPath: '/agent/sessions/200.jsonl',
    cwd: '/project-100',
    projectName: 'project-100',
    title: '中文 NEEDLE',
    modified: '1970-01-01T00:03:20.000Z'
  })
})

it('bounds recent results with deterministic ties and skips invalid cwd/identity without inventing status', async () => {
  const session = (cwd: string, path: string, id: string) => ({
    cwd,
    path,
    id,
    created: new Date(0),
    modified: new Date(0),
    messageCount: 1,
    firstMessage: 'same',
    allMessagesText: 'private'
  })
  const options = {
    query: '',
    limit: 2,
    agentDir: '/agent',
    manager: {
      listAll: async () => [
        session('/b', '/s/b', 'b'),
        session('/a', '/s/z', 'z'),
        session('/a', '/s/a', 'a'),
        session('relative', '/s/wrong', 'wrong'),
        session('/a', '/s/long', 'x'.repeat(1025))
      ]
    },
    directories: async () => [],
    normalize: async (path: string) => path
  }
  const result = await searchSessions(options)
  expect(result.items.map((item) => item.id)).toEqual(['a', 'z'])
  expect(result).toMatchObject({ total: 3, truncated: true, skippedEntries: 2 })
  expect(result.items[0]).not.toHaveProperty('status')
  await expect(searchSessions({ ...options, limit: 51 })).rejects.toThrow()
})

it('reuses discovery safety to skip linked JSONL directories and never asks the SDK to read them', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-search-safe-')))
  try {
    await mkdir(join(root, 'sessions', 'safe'), { recursive: true })
    await mkdir(join(root, 'sessions', 'unsafe'))
    await mkdir(join(root, 'outside'))
    await writeFile(join(root, 'outside', 'secret.jsonl'), 'private')
    await symlink(
      join(root, 'outside', 'secret.jsonl'),
      join(root, 'sessions', 'unsafe', 'linked.jsonl')
    )
    await symlink(join(root, 'outside'), join(root, 'sessions', 'linked-directory'))
    const read: string[] = []
    const result = await searchSessions({
      query: '',
      limit: 50,
      agentDir: root,
      manager: {
        listAll: async (path) => {
          read.push(path!)
          return []
        }
      }
    })
    expect(result.skippedDirectories).toBe(1)
    expect(read.sort()).toEqual([join(root, 'sessions'), join(root, 'sessions', 'safe')].sort())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('finds off-cap projects and empty trusted recent directories, canonicalizing exact identities', async () => {
  const result = await searchProjects({
    query: 'Empty',
    limit: 50,
    agentDir: '/agent',
    manager: { listAll: async () => [] },
    directories: async () => [],
    recentPaths: [...Array.from({ length: 110 }, (_, i) => `/project-${i}`), '/Empty', '/alias'],
    normalize: async (path) => (path === '/alias' ? '/Empty' : path)
  })
  expect(result.items).toEqual([{ cwd: '/Empty', projectName: 'Empty', available: true }])
  expect(result.total).toBe(1)
})

it('retains the SDK session cwd identity even when the catalog can canonicalize an alias', async () => {
  const result = await searchSessions({
    query: '',
    limit: 50,
    agentDir: '/agent',
    directories: async () => [],
    normalize: async () => '/real-project',
    manager: {
      listAll: async () => [
        {
          id: 'alias',
          path: '/agent/sessions/alias.jsonl',
          cwd: '/alias-project',
          created: new Date(0),
          modified: new Date(0),
          messageCount: 1,
          firstMessage: 'Alias session',
          allMessagesText: ''
        }
      ]
    }
  })
  expect(result.items[0].cwd).toBe('/alias-project')
})
