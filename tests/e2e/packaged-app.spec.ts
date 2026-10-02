import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
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
/** Runs the same check on a development build: the Electron binary plus this app path. */
const appPath = process.env.PI_DESKTOP_PACKAGED_APP_PATH
test.skip(!executable, 'PI_DESKTOP_PACKAGED_EXECUTABLE is not set')

let app: ElectronApplication, page: Page, root: string, project: string
let server: Server | undefined
const errors: string[] = []

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-packaged-')))
  const home = join(root, 'home')
  project = join(root, 'project')
  // The Pi engine keeps its configuration in the app's own data directory.
  const agent = join(root, 'data', 'runtimes', 'pi', 'config')
  for (const path of [project, agent, join(root, 'data'), join(root, 'appdata')])
    await mkdir(path, { recursive: true })
  // An offline model behind an OpenAI-compatible endpoint, configured as a user would.
  server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end()
        return
      }
      const chunk = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`
      const base = { id: 'packaged', object: 'chat.completion.chunk', created: 0, model: 'offline' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        chunk({
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'PACKAGED_REPLY' },
              finish_reason: null
            }
          ]
        }) +
          chunk({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          }) +
          'data: [DONE]\n\n'
      )
    })
  })
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
  const port = (server.address() as AddressInfo).port
  await writeFile(
    join(agent, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: 'openai-completions',
          models: [
            {
              id: 'offline',
              name: 'Offline',
              reasoning: false,
              input: ['text'],
              contextWindow: 8192,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    })
  )
  await writeFile(
    join(agent, 'auth.json'),
    JSON.stringify({ fixture: { type: 'api_key', key: 'offline-only' } })
  )
  errors.length = 0
  app = await electron.launch({
    executablePath: executable!,
    args: [
      ...(appPath ? [appPath] : []),
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
  const testInfo = test.info()
  // What the app saw, when it did not do what was expected.
  if (testInfo.status !== testInfo.expectedStatus && page) {
    const state = await page.evaluate(() => window.pi.getState()).catch(() => null)
    console.log('accounts:', JSON.stringify(state?.accounts ?? null))
    console.log(
      'notices:',
      JSON.stringify((state as { notices?: unknown } | null)?.notices ?? null)
    )
    for (const name of ['main.log', 'main.old.log'])
      console.log(
        name,
        await readFile(join(root, 'data', 'logs', name), 'utf8').catch(() => '(none)')
      )
  }
  await app?.close()
  await new Promise((done) => (server ? server.close(done) : done(undefined)))
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('the installed app starts, chats offline with the Pi engine and runs a terminal', async () => {
  test.setTimeout(120_000)
  const facts = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion()
  }))
  expect(facts.packaged).toBe(!appPath)
  if (version) expect(facts.version).toBe(version)

  // The Pi engine host starts from inside the package and loads the user's extension.
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  // The endpoint's model becomes selectable once the engine host has read models.json.
  await expect
    .poll(
      async () => {
        await page
          .evaluate(() =>
            window.pi.send({ type: 'model:set', providerId: 'fixture', modelId: 'offline' })
          )
          .catch(() => undefined)
        return page.evaluate(async () => (await window.pi.getState()).activeProvider)
      },
      { timeout: 30_000 }
    )
    .toBe('fixture')
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
  // A failed start names its reason (spawn, host-io, …) in the mismatch.
  await expect
    .poll(async () => {
      const listed = await page.evaluate(
        (projectPath) => window.pi.terminal({ type: 'list', projectPath }),
        project
      )
      const current = listed.type === 'list' ? listed.terminals[0] : undefined
      return current?.failure ? `failed: ${current.failure}` : current?.state
    })
    .toBe('running')
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
