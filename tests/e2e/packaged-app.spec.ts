import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TerminalEvent, TerminalMetadata } from '../../src/shared/terminal'
import { displayEnv } from './display-env'

declare global {
  interface Window {
    packagedTerminalOutput: string
  }
}

/**
 * The installed application as users get it: not the development build and not E2E mode,
 * which the packaged app refuses. It runs with a throwaway home, so its settings, the Pi
 * agent directory and its data all live in a temporary directory.
 */
const executable = process.env.PI_DESKTOP_PACKAGED_EXECUTABLE
const version = process.env.PI_DESKTOP_PACKAGED_VERSION
test.skip(!executable, 'PI_DESKTOP_PACKAGED_EXECUTABLE is not set')

let app: ElectronApplication, page: Page, root: string, project: string
const errors: string[] = []

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-packaged-')))
  const home = join(root, 'home')
  project = join(root, 'project')
  const agent = join(home, '.pi', 'agent')
  for (const path of [
    project,
    join(agent, 'extensions'),
    join(root, 'data'),
    join(root, 'appdata')
  ])
    await mkdir(path, { recursive: true })
  // An offline model, provided the way any user extension would be.
  const ai = resolve('node_modules/@earendil-works/pi-ai')
  const pkg = JSON.parse(await readFile(join(ai, 'package.json'), 'utf8'))
  await writeFile(
    join(agent, 'auth.json'),
    JSON.stringify({ fixture: { type: 'api_key', key: 'offline-only' } })
  )
  await writeFile(
    join(agent, 'extensions', 'packaged-fixture.ts'),
    `
    import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(resolve(ai, pkg.exports['.'].import))};
    export default function(pi) {
      const faux = fauxProvider({ provider: 'fixture', api: 'fixture-api', models: [{id:'offline'}], tokensPerSecond:1000 });
      faux.setResponses([fauxAssistantMessage('PACKAGED_REPLY')]);
      pi.registerProvider(faux.provider);
    }`
  )
  errors.length = 0
  app = await electron.launch({
    executablePath: executable!,
    args: [
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      `--user-data-dir=${join(root, 'data')}`
    ],
    env: {
      ...displayEnv(),
      PATH: process.env.PATH ?? '',
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(root, 'appdata'),
      LOCALAPPDATA: join(root, 'appdata'),
      XDG_CONFIG_HOME: join(root, 'appdata'),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      ...(process.env.APPIMAGE_EXTRACT_AND_RUN ? { APPIMAGE_EXTRACT_AND_RUN: '1' } : {})
    }
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await expect
    .poll(() => page.evaluate(async () => (await window.pi.getState()).ready), { timeout: 30_000 })
    .toBe(true)
})
test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('the installed app starts, chats offline with the Pi engine and runs a terminal', async () => {
  test.setTimeout(120_000)
  const facts = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion()
  }))
  expect(facts.packaged).toBe(true)
  if (version) expect(facts.version).toBe(version)

  // The Pi engine host starts from inside the package and loads the user's extension.
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await expect
    .poll(
      () =>
        page.evaluate(
          async () =>
            (await window.pi.getState()).accounts.find((account) => account.id === 'fixture')
              ?.connected ?? false
        ),
      { timeout: 30_000 }
    )
    .toBe(true)
  await page.evaluate(() =>
    window.pi.send({ type: 'model:set', providerId: 'fixture', modelId: 'offline' })
  )
  await page.evaluate(async () => {
    const state = await window.pi.getState()
    await window.pi.send({
      type: 'prompt:send',
      text: 'hello from the installed app',
      sessionId: state.sessionId!,
      generation: state.generation
    })
  })
  await expect
    .poll(
      () =>
        page.evaluate(async () =>
          (await window.pi.getState()).nodes
            .map((node) => (node.type === 'assistant' ? node.markdown : ''))
            .join('')
        ),
      { timeout: 30_000 }
    )
    .toContain('PACKAGED_REPLY')

  // The terminal's native module is unpacked from the archive; a shell must start and answer.
  await expect
    .poll(async () => {
      const { state } = await page.evaluate(() => window.pi.workbench({ type: 'state:get' }))
      return state.plugins.some(
        (plugin) => plugin.pluginId === 'works.pi.terminal' && plugin.desktopEnabled
      )
    })
    .toBe(true)
  await page.evaluate(() => {
    window.packagedTerminalOutput = ''
    window.pi.onTerminalEvent((event: TerminalEvent) => {
      if (event.type !== 'output') return
      window.packagedTerminalOutput += event.data
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
  const created = await page.evaluate(
    (projectPath) => window.pi.terminal({ type: 'create', projectPath, cols: 80, rows: 24 }),
    project
  )
  if (created.type !== 'terminal') throw new Error(`Terminal not created: ${created.type}`)
  const terminal: TerminalMetadata = created.terminal
  const identity = {
    projectPath: terminal.projectPath,
    terminalId: terminal.terminalId,
    generation: terminal.generation,
    connectionEpoch: terminal.connectionEpoch
  }
  await page.evaluate((identity) => window.pi.terminal({ type: 'attach', ...identity }), identity)
  // `echo` reads the same in zsh, bash and PowerShell; the joined marker proves it ran.
  await page.evaluate(
    (identity) =>
      window.pi.terminal({ type: 'input', ...identity, data: 'echo PACKAGED_TERM""INAL\r' }),
    identity
  )
  await expect
    .poll(() => page.evaluate(() => window.packagedTerminalOutput), { timeout: 30_000 })
    .toContain('PACKAGED_TERMINAL')
  await page.evaluate((identity) => window.pi.terminal({ type: 'close', ...identity }), identity)

  expect(errors).toEqual([])
})
