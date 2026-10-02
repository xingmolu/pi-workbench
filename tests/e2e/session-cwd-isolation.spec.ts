import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PiDesktopAPI } from '../../src/shared/contracts'
import { displayEnv } from './display-env'

declare global {
  interface Window {
    pi: PiDesktopAPI
  }
}

let app: ElectronApplication | undefined
let page: Page
let root: string
let a: string
let b: string
let pa: string
let pb: string
let originals: string[]

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-cwd-isolation-')))
  a = join(root, 'a-b')
  b = join(root, 'a', 'b')
  const agentDir = join(root, 'agent')
  const bucket = (cwd: string) =>
    join(agentDir, 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
  expect(bucket(a)).toBe(bucket(b))
  await Promise.all(
    [a, b, join(root, 'home'), join(root, 'user-data'), bucket(a)].map((p) =>
      mkdir(p, { recursive: true })
    )
  )
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
  const seed = async (cwd: string, id: string, timestamp: string) => {
    const path = join(bucket(cwd), id + '.jsonl')
    await writeFile(
      path,
      [
        { type: 'session', version: 3, id, timestamp, cwd },
        {
          type: 'thinking_level_change',
          id: id + 'thinking',
          parentId: null,
          timestamp,
          thinkingLevel: 'off'
        },
        {
          type: 'message',
          id: id + 'u',
          parentId: id + 'thinking',
          timestamp,
          message: { role: 'user', content: id + ' question', timestamp: Date.parse(timestamp) }
        },
        {
          type: 'message',
          id: id + 'a',
          parentId: id + 'u',
          timestamp,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: id + ' answer' }],
            api: 'openai-responses',
            provider: 'openai',
            model: 'fixture-unavailable',
            usage,
            stopReason: 'stop',
            timestamp: Date.parse(timestamp)
          }
        },
        {
          type: 'session_info',
          id: id + 'name',
          parentId: id + 'a',
          timestamp,
          name: id + ' title'
        }
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n'
    )
    await utimes(path, new Date(timestamp), new Date(timestamp))
    return path
  }
  pa = await seed(a, 'project-a', '2026-09-10T00:00:00.000Z')
  pb = await seed(b, 'project-b', '2026-09-11T00:00:00.000Z')
  originals = await Promise.all([pa, pb].map((p) => readFile(p, 'utf8')))
  await writeFile(join(agentDir, 'models.json'), '{"providers":{}}')
  await writeFile(join(agentDir, 'auth.json'), '{}')
  await writeFile(
    join(agentDir, 'settings.json'),
    '{"compaction":{"enabled":false},"retry":{"enabled":false}}'
  )
  app = await electron.launch({
    args: [resolve('.')],
    cwd: a,
    env: {
      ...displayEnv(),
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: agentDir,
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data')
    }
  })
  page = await app.firstWindow()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
})

test.afterEach(async () => {
  await app?.close()
  app = undefined
  if (root) await rm(root, { recursive: true, force: true })
})

async function open(cwd: string, id: string) {
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), cwd)
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).sessionId))
    .toBe(id)
  await expect(page.locator('.conversation-session-title')).toHaveText(id + ' title')
  await expect(page.locator('.node-flow')).toContainText(id + ' answer')
  const sessions = await page.evaluate(async () => (await window.pi.getState()).sessions)
  expect(sessions.map((s) => s.title)).toEqual([id + ' title'])
}

test('colliding projects list and auto-resume only their own canonical history; explicit foreign path rejects', async () => {
  await open(a, 'project-a')
  await expect(page.locator('.node-flow')).not.toContainText('project-b')
  const before = await page.evaluate(() => window.pi.getState())
  const error = await page.evaluate(async (path) => {
    try {
      await window.pi.send({ type: 'session:open', path })
      return null
    } catch (error) {
      return String(error)
    }
  }, pb)
  expect(error).toContain('会话不属于当前工作区')
  const after = await page.evaluate(() => window.pi.getState())
  expect(after.project).toEqual(before.project)
  expect(after.sessionId).toBe(before.sessionId)
  expect(after.nodes).toEqual(before.nodes)
  await open(b, 'project-b')
  await expect(page.locator('.node-flow')).not.toContainText('project-a')
  await open(a, 'project-a')
  expect(await Promise.all([pa, pb].map((p) => readFile(p, 'utf8')))).toEqual(originals)
})

test('when only B history exists, opening A creates an empty A session', async () => {
  await rm(pa)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), a)
  const state = await page.evaluate(() => window.pi.getState())
  expect(state.project?.path).toBe(a)
  expect(state.sessionId).not.toBe('project-b')
  expect(state.nodes).toEqual([])
  expect(state.sessions).toEqual([])
  await expect(page.locator('.conversation')).not.toContainText('project-b')
  expect(await readFile(pb, 'utf8')).toBe(originals[1])
})
