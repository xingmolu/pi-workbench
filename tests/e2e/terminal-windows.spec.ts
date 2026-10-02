import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TerminalEvent, TerminalIdentity, TerminalMetadata } from '../../src/shared/terminal'
import { displayEnv } from './display-env'

declare global {
  interface Window {
    terminalWindowsEvents: TerminalEvent[]
  }
}

// The POSIX terminal specs drive zsh and Unix job control; this one drives PowerShell.
test.skip(process.platform !== 'win32', 'Windows terminal')

let app: ElectronApplication, page: Page, root: string, project: string
const cap = (t: TerminalMetadata): TerminalIdentity => ({
  projectPath: t.projectPath,
  terminalId: t.terminalId,
  generation: t.generation,
  connectionEpoch: t.connectionEpoch
})
const list = async (): Promise<TerminalMetadata[]> => {
  const result = await page.evaluate(
    (projectPath) => window.pi.terminal({ type: 'list', projectPath }),
    project
  )
  return result.type === 'list' ? result.terminals : []
}
const output = (): Promise<string> =>
  page.evaluate(() =>
    window.terminalWindowsEvents
      .filter((event) => event.type === 'output')
      .map((event) => event.data)
      .join('')
  )

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-terminal-windows-')))
  project = join(root, 'project')
  for (const path of ['home', 'agent', 'data', 'project']) await mkdir(join(root, path))
  app = await electron.launch({
    args: [resolve('.')],
    env: {
      ...displayEnv(),
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'data')
    }
  })
  page = await app.firstWindow()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await expect
    .poll(async () => {
      const { state } = await page.evaluate(() => window.pi.workbench({ type: 'state:get' }))
      return state.plugins.some(
        (plugin) => plugin.pluginId === 'works.pi.terminal' && plugin.desktopEnabled
      )
    })
    .toBe(true)
  await page.evaluate(() => {
    window.terminalWindowsEvents = []
    window.pi.onTerminalEvent((event) => {
      window.terminalWindowsEvents.push(event)
      if (event.type === 'output')
        void window.pi.terminal({
          type: 'ack',
          projectPath: event.projectPath,
          terminalId: event.terminalId,
          generation: event.generation,
          connectionEpoch: event.connectionEpoch,
          sequence: event.sequence
        })
    })
  })
})
test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('a PowerShell terminal opens in the project, runs commands and closes', async () => {
  const created = await page.evaluate(
    (projectPath) => window.pi.terminal({ type: 'create', projectPath, cols: 80, rows: 24 }),
    project
  )
  expect(created).toMatchObject({ type: 'terminal' })
  if (created.type !== 'terminal') throw new Error('Create failed')
  const terminal = cap(created.terminal)
  await page.evaluate((identity) => window.pi.terminal({ type: 'attach', ...identity }), terminal)
  // A failed start names its reason (spawn, host-exit, …) in the mismatch.
  await expect
    .poll(async () => {
      const [terminal] = await list()
      return terminal?.failure ? `failed: ${terminal.failure}` : terminal?.state
    })
    .toBe('running')

  const run = (data: string): Promise<unknown> =>
    page.evaluate(
      ({ identity, data }) => window.pi.terminal({ type: 'input', ...identity, data }),
      { identity: terminal, data }
    )
  await run('Write-Output "PI_$(20+22)"; (Get-Location).Path; $PSVersionTable.PSEdition\r')
  await expect.poll(output).toContain('PI_42')
  expect(await output()).toContain(project)
  expect(await output()).toContain('Core')
  // node-pty on Windows only ever names the shell, so a running program is not detected.
  expect((await list())[0]?.busy).toBe(false)

  await page.evaluate((identity) => window.pi.terminal({ type: 'close', ...identity }), terminal)
  await expect.poll(async () => (await list())[0]?.exitConfirmed ?? true).toBe(true)
})
