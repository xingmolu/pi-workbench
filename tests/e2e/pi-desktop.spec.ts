import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { PiDesktopAPI } from '../../src/shared/contracts'

const repoRoot = resolve(__dirname, '../..')
const artifactDir = join(repoRoot, 'artifacts/e2e')

type RendererErrors = {
  pageErrors: string[]
  consoleErrors: string[]
}

type TestPaths = {
  root: string
  userData: string
  agentDir: string
  project: string
  baitAgentDir: string
  baitAuth: string
  baitModels: string
  baitMultiLoginConfig: string
  baitSessionDir: string
  baitSession: string
}

type BaitFingerprint = {
  hash: string
  mode: number
}

let paths: TestPaths
let electronApp: ElectronApplication | null = null
let rendererErrors: RendererErrors | null = null
let preRestartSessionId: string | null = null
let preRestartGeneration: number | null = null
let baitFingerprints = new Map<string, BaitFingerprint>()

function launchEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const name of [
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'XAUTHORITY',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT'
  ]) {
    const value = process.env[name]
    if (value) environment[name] = value
  }
  return {
    ...environment,
    HOME: paths.root,
    TMPDIR: paths.root,
    TMP: paths.root,
    TEMP: paths.root,
    PI_DESKTOP_E2E: '1',
    PI_DESKTOP_E2E_USER_DATA: paths.userData,
    PI_DESKTOP_E2E_AGENT_DIR: paths.agentDir,
    PI_CODING_AGENT_DIR: paths.baitAgentDir,
    PI_MULTI_LOGIN_CONFIG: paths.baitMultiLoginConfig,
    PI_CODING_AGENT_SESSION_DIR: paths.baitSessionDir
  }
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

async function baitFingerprint(path: string): Promise<BaitFingerprint> {
  const [content, metadata] = await Promise.all([readFile(path), stat(path)])
  return {
    hash: createHash('sha256').update(content).digest('hex'),
    mode: metadata.mode & 0o777
  }
}

async function expectBaitUntouched(): Promise<void> {
  expect((await readdir(paths.baitAgentDir)).sort()).toEqual([
    'auth.json',
    'models.json',
    'pi-multi-login.json',
    'sentinel.txt',
    'sessions'
  ])
  expect(await pathExists(paths.baitSession)).toBe(true)
  for (const [path, expected] of baitFingerprints) {
    expect(await baitFingerprint(path), `bait changed: ${path}`).toEqual(expected)
  }
}

async function expectNoRealIdentityInRenderer(page: Page): Promise<void> {
  const bodyText = await page.locator('body').innerText()
  expect(bodyText).not.toContain(homedir())
  const realUser = process.env.USER
  if (realUser && realUser.length > 2) expect(bodyText).not.toContain(realUser)
  expect(bodyText).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}\b/)
  expect(bodyText).not.toMatch(/\bBearer\s+[A-Za-z0-9._-]{16,}\b/i)
}

async function resizeWindow(width: number, height: number): Promise<void> {
  if (!electronApp) throw new Error('Electron app is not running')
  await electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('Main window is missing')
      window.setContentSize(size.width, size.height)
    },
    { width, height }
  )
}

function collectRendererErrors(page: Page): RendererErrors {
  const errors: RendererErrors = { pageErrors: [], consoleErrors: [] }
  page.on('pageerror', (error) => errors.pageErrors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.consoleErrors.push(message.text())
  })
  return errors
}

async function launchApp(): Promise<Page> {
  electronApp = await electron.launch({
    args: [repoRoot],
    cwd: repoRoot,
    env: launchEnvironment()
  })
  const page = await electronApp.firstWindow()
  rendererErrors = collectRendererErrors(page)
  await page.waitForLoadState('domcontentloaded')
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as Window & { pi: PiDesktopAPI }).pi
          .getState()
          .then((state) => state.ready)
      )
    )
    .toBe(true)
  return page
}

async function expectNoRendererErrors(): Promise<void> {
  expect(rendererErrors?.pageErrors ?? [], 'renderer page errors').toEqual([])
  expect(rendererErrors?.consoleErrors ?? [], 'renderer console errors').toEqual([])
}

test.describe.serial('Pi Desktop real Electron app', () => {
  test.beforeAll(async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-')))
    paths = {
      root,
      userData: join(root, 'user-data'),
      agentDir: join(root, 'agent'),
      project: join(root, `e2e-project-${basename(root)}`),
      baitAgentDir: join(root, 'inherited-bait-agent'),
      baitAuth: join(root, 'inherited-bait-agent', 'auth.json'),
      baitModels: join(root, 'inherited-bait-agent', 'models.json'),
      baitMultiLoginConfig: join(root, 'inherited-bait-agent', 'pi-multi-login.json'),
      baitSessionDir: join(root, 'inherited-bait-agent', 'sessions'),
      baitSession: join(root, 'inherited-bait-agent', 'sessions', '2099-01-01-poison.jsonl')
    }
    await Promise.all([
      mkdir(paths.userData, { recursive: true }),
      mkdir(paths.agentDir, { recursive: true }),
      mkdir(paths.project, { recursive: true }),
      mkdir(paths.baitAgentDir, { recursive: true }),
      mkdir(paths.baitSessionDir, { recursive: true }),
      mkdir(artifactDir, { recursive: true })
    ])
    const baitFiles = new Map<string, string>([
      [join(paths.baitAgentDir, 'sentinel.txt'), 'untouched\n'],
      [paths.baitAuth, '{ malformed-auth-bait\n'],
      [paths.baitModels, '{ malformed-models-bait\n'],
      [paths.baitMultiLoginConfig, '{ malformed-multi-login-bait\n'],
      [
        paths.baitSession,
        `${JSON.stringify({
          type: 'session',
          version: 3,
          id: 'poison-bait-session',
          timestamp: '2099-01-01T00:00:00.000Z',
          cwd: paths.project
        })}\n`
      ]
    ])
    for (const [path, content] of baitFiles) {
      await writeFile(path, content, { mode: 0o400 })
      await chmod(path, 0o400)
    }
    baitFingerprints = new Map(
      await Promise.all(
        [...baitFiles].map(async ([path]) => [path, await baitFingerprint(path)] as const)
      )
    )
    expect(
      Object.keys(launchEnvironment()).filter((name) =>
        /(?:API_KEY|ACCESS_TOKEN|SECRET_KEY|OPENAI|ANTHROPIC|AWS_|AZURE_|GOOGLE_APPLICATION)/i.test(
          name
        )
      )
    ).toEqual([])
  })

  test.afterEach(async () => {
    const app = electronApp
    try {
      await expectNoRendererErrors()
    } finally {
      try {
        if (app) await app.close()
        if (electronApp === app) electronApp = null
      } finally {
        rendererErrors = null
      }
    }
  })

  test.afterAll(async () => {
    if (electronApp) await electronApp.close().catch(() => undefined)
    if (paths?.root) await rm(paths.root, { recursive: true, force: true })
  })

  test('empty, responsive settings, project open, and bare new-session use real IPC', async () => {
    const page = await launchApp()
    await resizeWindow(1440, 900)

    const emptyState = await page.evaluate(() =>
      (window as unknown as Window & { pi: PiDesktopAPI }).pi.getState()
    )
    expect(emptyState.ready).toBe(true)
    expect(emptyState.agentDir).toBe(paths.agentDir)
    expect(emptyState.project).toBeNull()
    expect(emptyState.accounts.every((account) => !account.connected)).toBe(true)
    await expectBaitUntouched()
    await expect(page.locator('.hero-copy')).toHaveCount(1)
    await expect(page.getByRole('button', { name: '选择工作区' })).toHaveCount(1)
    await expect(page.locator('.workbench.is-collapsed')).toHaveCount(1)
    await expectNoRealIdentityInRenderer(page)
    await expect
      .poll(() =>
        page.locator('.workbench').evaluate((element) => element.getBoundingClientRect().width)
      )
      .toBeGreaterThanOrEqual(50)
    await expect
      .poll(() =>
        page.locator('.workbench').evaluate((element) => element.getBoundingClientRect().width)
      )
      .toBeLessThanOrEqual(54)
    await page.screenshot({ path: join(artifactDir, '01-empty.png') })

    await resizeWindow(960, 720)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.locator('.settings-panel')).toBeVisible()
    await expect(page.locator('aside.sidebar.is-collapsed')).toBeVisible()
    await expect
      .poll(() =>
        page.locator('.sidebar').evaluate((element) => element.getBoundingClientRect().width)
      )
      .toBeLessThanOrEqual(58)
    await expect
      .poll(() =>
        page.locator('.workbench').evaluate((element) => element.getBoundingClientRect().width)
      )
      .toBeLessThanOrEqual(342)
    await expect
      .poll(() =>
        page.locator('.settings-panel').evaluate((element) => element.getBoundingClientRect().width)
      )
      .toBeGreaterThan(320)
    const bounds = await page.evaluate(() => {
      const conversation = document.querySelector('.conversation')?.getBoundingClientRect()
      const composer = document.querySelector('.composer-axis')?.getBoundingClientRect()
      return {
        innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        conversation: conversation
          ? { left: conversation.left, right: conversation.right, width: conversation.width }
          : null,
        composer: composer
          ? { left: composer.left, right: composer.right, width: composer.width }
          : null
      }
    })
    expect(bounds.documentScrollWidth).toBeLessThanOrEqual(bounds.innerWidth)
    expect(bounds.bodyScrollWidth).toBeLessThanOrEqual(bounds.innerWidth)
    expect(bounds.conversation).not.toBeNull()
    expect(bounds.composer).not.toBeNull()
    expect(bounds.conversation!.left).toBeGreaterThanOrEqual(0)
    expect(bounds.conversation!.right).toBeLessThanOrEqual(bounds.innerWidth + 1)
    expect(bounds.composer!.left).toBeGreaterThanOrEqual(bounds.conversation!.left - 1)
    expect(bounds.composer!.right).toBeLessThanOrEqual(bounds.conversation!.right + 1)
    await expectNoRealIdentityInRenderer(page)
    await page.screenshot({ path: join(artifactDir, '02-settings-960.png') })

    await page.getByTitle('关闭设置').click()
    await expect(page.locator('aside.sidebar[aria-label="项目和会话"]')).toBeVisible()
    await expect(page.locator('.workbench.is-collapsed')).toBeVisible()
    await resizeWindow(1440, 900)
    await expect
      .poll(() =>
        page.locator('.workbench').evaluate((element) => element.getBoundingClientRect().width)
      )
      .toBeLessThanOrEqual(54)

    const opened = await page.evaluate(async (projectPath) => {
      return (window as unknown as Window & { pi: PiDesktopAPI }).pi.send({
        type: 'project:open',
        cwd: projectPath
      })
    }, paths.project)
    expect(opened.kind).toBe('snapshot')
    if (opened.kind !== 'snapshot') throw new Error('project:open did not return a snapshot')
    expect(opened.snapshot.ready).toBe(true)
    expect(opened.snapshot.agentDir).toBe(paths.agentDir)
    expect(opened.snapshot.project?.path).toBe(paths.project)
    expect(opened.snapshot.accounts.every((account) => !account.connected)).toBe(true)

    await expect(page.locator('.project-row strong')).toHaveText(basename(paths.project))
    await expect(page.locator('.composer-lock')).toContainText('登录 Codex')
    const beforeSessionId = opened.snapshot.sessionId
    const beforeGeneration = opened.snapshot.generation
    const sessionResult = await page.evaluate(async () =>
      (window as unknown as Window & { pi: PiDesktopAPI }).pi.send({ type: 'session:new' })
    )
    expect(sessionResult.kind).toBe('snapshot')
    if (sessionResult.kind !== 'snapshot') throw new Error('session:new did not return a snapshot')
    expect(sessionResult.snapshot.project?.path).toBe(paths.project)
    expect(sessionResult.snapshot.agentDir).toBe(paths.agentDir)
    expect(sessionResult.snapshot.generation).toBeGreaterThan(beforeGeneration)
    expect(sessionResult.snapshot.sessionId).not.toBe(beforeSessionId)
    expect(sessionResult.snapshot.composeBlockReason).toBe('login-required')
    preRestartSessionId = sessionResult.snapshot.sessionId
    preRestartGeneration = sessionResult.snapshot.generation
    expect(preRestartSessionId).not.toBeNull()
    expect(await readdir(paths.agentDir)).toContain('sessions')
    expect((await readdir(join(paths.agentDir, 'sessions'))).length).toBeGreaterThan(0)
    await expectBaitUntouched()
    await expect(page.locator('.composer-lock')).toContainText('登录 Codex')
    await expectNoRealIdentityInRenderer(page)
    await page.screenshot({ path: join(artifactDir, '03-project-locked.png') })
  })

  test('restart restores the recent project with a fresh host state', async () => {
    const page = await launchApp()
    await resizeWindow(1440, 900)

    const state = await page.evaluate(() =>
      (window as unknown as Window & { pi: PiDesktopAPI }).pi.getState()
    )
    expect(state.ready).toBe(true)
    expect(state.agentDir).toBe(paths.agentDir)
    expect(state.project?.path).toBe(paths.project)
    expect(preRestartSessionId).not.toBeNull()
    expect(preRestartGeneration).not.toBeNull()
    expect(state.sessionId).not.toBe(preRestartSessionId)
    expect(state.generation).toBeLessThan(preRestartGeneration!)
    expect(state.nodes).toEqual([])
    expect(state.activeSessionPath).toBeNull()
    expect(state.metrics).toEqual({
      turns: 0,
      steps: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    })
    expect(state.permissionMode).toBe('ask')
    expect(state.status).toBe('idle')
    expect(state.followUp).toEqual([])
    expect(state.approvals).toEqual([])
    expect(state.queuedCount).toBe(0)
    expect(state.accounts.every((account) => !account.connected)).toBe(true)
    await expectBaitUntouched()
    await expect(page.locator('aside.sidebar[aria-label="项目和会话"]')).toBeVisible()
    await expect(page.locator('.workbench.is-collapsed')).toBeVisible()
    await expect(page.locator('.project-row strong')).toHaveText(basename(paths.project))
    await expect(page.locator('.composer-lock')).toContainText('登录 Codex')
    await expectNoRealIdentityInRenderer(page)
    await page.screenshot({ path: join(artifactDir, '04-restored.png') })
  })
})
