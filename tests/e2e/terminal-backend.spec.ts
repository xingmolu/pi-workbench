import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { TerminalEvent, TerminalIdentity, TerminalMetadata } from '../../src/shared/terminal'
import { displayEnv } from './display-env'

declare global {
  interface Window {
    terminalBackendEvents: TerminalEvent[]
  }
}
let app: ElectronApplication
let child: ChildProcess
let page: Page
let root: string
let project: string
const cap = (t: TerminalMetadata): TerminalIdentity => ({
  projectPath: t.projectPath,
  terminalId: t.terminalId,
  generation: t.generation,
  connectionEpoch: t.connectionEpoch
})

async function subscribe(): Promise<void> {
  await page.evaluate(() => {
    window.terminalBackendEvents = []
    window.pi.onTerminalEvent((event) => {
      window.terminalBackendEvents.push(event)
      // Test consumer acknowledges its recorded bytes; this is not an xterm/native keyboard test.
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
}
async function create(): Promise<TerminalMetadata> {
  const result = await page.evaluate(
    (projectPath) => window.pi.terminal({ type: 'create', projectPath, cols: 80, rows: 24 }),
    project
  )
  expect(result, 'terminal create result').toMatchObject({ type: 'terminal' })
  if (result.type !== 'terminal') throw new Error('Create failed')
  await page.evaluate(
    (identity) => window.pi.terminal({ type: 'attach', ...identity }),
    cap(result.terminal)
  )
  await expect
    .poll(async () => {
      const listed = await page.evaluate(
        (projectPath) => window.pi.terminal({ type: 'list', projectPath }),
        project
      )
      return (
        listed.type === 'list' &&
        listed.terminals.find((t) => t.terminalId === result.terminal.terminalId)?.state
      )
    })
    .toBe('running')
  return result.terminal
}
async function output(): Promise<string> {
  return page.evaluate(() =>
    window.terminalBackendEvents
      .filter((e) => e.type === 'output')
      .map((e) => e.data)
      .join('')
  )
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function pids(file: string): Promise<number[]> {
  await expect
    .poll(async () => {
      try {
        return (await readFile(file, 'utf8')).trim().length > 0
      } catch {
        return false
      }
    })
    .toBe(true)
  const values = (await readFile(file, 'utf8')).trim().split(' ').map(Number)
  expect(values.every((pid) => Number.isSafeInteger(pid) && pid > 1)).toBe(true)
  return values
}
test.beforeEach(async ({}, testInfo) => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-terminal-backend-')))
  project = join(root, 'project')
  for (const path of ['home', 'agent', 'data', 'project', 'other']) await mkdir(join(root, path))
  let appPath = resolve('.')
  if (
    testInfo.title ===
    'actual asynchronous node-pty write failure is visible without leaking diagnostics'
  ) {
    appPath = join(root, 'fixture-app')
    await mkdir(appPath)
    await cp(resolve('out'), join(appPath, 'out'), { recursive: true })
    await cp(resolve('resources'), join(appPath, 'resources'), { recursive: true })
    await symlink(resolve('node_modules'), join(appPath, 'node_modules'), 'dir')
    await writeFile(
      join(appPath, 'package.json'),
      JSON.stringify({
        name: 'terminal-fixture',
        // Bundled plugin compatibility is checked against the actual app version.
        version: JSON.parse(await readFile(resolve('package.json'), 'utf8')).version,
        main: './out/main/index.js'
      })
    )
    const hostPath = join(appPath, 'out/main/terminal-host.js')
    await rename(hostPath, join(appPath, 'out/main/terminal-host-production.js'))
    await copyFile(resolve('scripts/terminal-io-failure-host.cjs'), hostPath)
  }
  app = await electron.launch({
    args: [appPath],
    env: {
      ...displayEnv(),
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
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
  child = app.process()
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
  await subscribe()
})
test.afterEach(async () => {
  if (child?.exitCode === null) await app.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test('real Main/preload/utility: isolated shell, resize, project ownership, reload management and confirmed close', async () => {
  const t = await create()
  await page.evaluate(
    (identity) => window.pi.terminal({ type: 'resize', ...identity, cols: 91, rows: 31 }),
    cap(t)
  )
  await page.evaluate(
    (identity) =>
      window.pi.terminal({
        type: 'input',
        ...identity,
        data: "printf 'PTY_%s\\n' '中文'; stty size; printf 'HOME=%s ZDOTDIR=%s\\n' \"$HOME\" \"$ZDOTDIR\"\r"
      }),
    cap(t)
  )
  await expect.poll(output).toContain('PTY_中文')
  await expect.poll(output).toContain('31 91')
  expect(await output()).toContain(`HOME=${root}/agent/terminal-home-`)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), join(root, 'other'))
  expect(
    await page.evaluate(
      (identity) =>
        window.pi.terminal({
          type: 'input',
          ...identity,
          data: "printf 'BACKGROUND_%s\\n' 'ORIGINAL'\r"
        }),
      cap(t)
    )
  ).toEqual({ type: 'ok' })
  await expect.poll(output).toContain('BACKGROUND_ORIGINAL')
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), project)
  await page.reload()
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await subscribe()
  const list = await page.evaluate(
    (projectPath) => window.pi.terminal({ type: 'list', projectPath }),
    project
  )
  expect(list.type).toBe('list')
  if (list.type !== 'list') throw new Error('Missing list')
  const degraded = list.terminals[0]!
  expect(degraded).toMatchObject({
    state: 'degraded',
    connection: 'management',
    exitConfirmed: false
  })
  expect(degraded.connectionEpoch).toBeGreaterThan(t.connectionEpoch)
  expect(
    await page.evaluate(
      (identity) => window.pi.terminal({ type: 'input', ...identity, data: 'forbidden' }),
      cap(t)
    )
  ).toMatchObject({ type: 'unavailable' })
  await page.evaluate(
    (identity) => window.pi.terminal({ type: 'attach', ...identity }),
    cap(degraded)
  )
  expect(
    await page.evaluate(
      (identity) => window.pi.terminal({ type: 'input', ...identity, data: 'forbidden' }),
      cap(degraded)
    )
  ).toMatchObject({ type: 'unavailable' })
  await page.evaluate(
    (identity) => window.pi.terminal({ type: 'close', ...identity }),
    cap(degraded)
  )
  await expect
    .poll(async () => {
      const result = await page.evaluate(
        (projectPath) => window.pi.terminal({ type: 'list', projectPath }),
        project
      )
      return result.type === 'list' && result.terminals[0]?.exitConfirmed
    })
    .toBe(true)
})

test('normal app.quit exits with a running fixture terminal', async () => {
  const t = await create()
  const pidFile = join(root, 'quit-shell.pid')
  await page.evaluate(
    ({ identity, file }) =>
      window.pi.terminal({ type: 'input', ...identity, data: `printf '%s' $$ > '${file}'\r` }),
    { identity: cap(t), file: pidFile }
  )
  const [shellPid] = await pids(pidFile)
  expect(alive(shellPid!)).toBe(true)
  const closed = new Promise<boolean>((resolve) => child.once('exit', () => resolve(true)))
  await app.evaluate(({ app }) => {
    setTimeout(() => app.quit(), 0)
  })
  expect(
    await Promise.race([
      closed,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000))
    ])
  ).toBe(true)
  await expect.poll(() => alive(shellPid!)).toBe(false)
})

test('explicit close hangs up its ordinary foreground and background fixture jobs', async () => {
  const t = await create()
  const file = join(root, 'ordinary.pids')
  await page.evaluate(
    ({ identity, file }) =>
      window.pi.terminal({
        type: 'input',
        ...identity,
        data: `/bin/sleep 15 & bg=$!; /bin/sleep 15 & foreground=$!; printf '%s %s %s' $$ $bg $foreground > '${file}'; fg %2\r`
      }),
    { identity: cap(t), file }
  )
  const owned = await pids(file)
  expect(owned).toHaveLength(3)
  expect(owned.every(alive)).toBe(true)
  await page.evaluate((identity) => window.pi.terminal({ type: 'close', ...identity }), cap(t))
  await expect.poll(() => owned.some(alive), { timeout: 5000 }).toBe(false)
})

test('disowned HUP-ignoring fixture may survive close and expires itself', async () => {
  const t = await create()
  const file = join(root, 'detached.pid')
  await page.evaluate(
    ({ identity, file }) =>
      window.pi.terminal({
        type: 'input',
        ...identity,
        data: `nohup /bin/sleep 4 >/dev/null 2>&1 & print -r -- $! > '${file}'; disown\r`
      }),
    { identity: cap(t), file }
  )
  const [owned] = await pids(file)
  await page.evaluate((identity) => window.pi.terminal({ type: 'close', ...identity }), cap(t))
  expect(alive(owned!)).toBe(true)
  // No broad cleanup or PID escalation: this exact fixture has its own short lifetime.
  await expect.poll(() => alive(owned!), { timeout: 7000 }).toBe(false)
})

test('real utility crash reports failed without fabricating shell exit', async () => {
  const t = await create()
  const file = join(root, 'crash-shell.pid')
  await page.evaluate(
    ({ identity, file }) =>
      window.pi.terminal({ type: 'input', ...identity, data: `printf '%s' $$ > '${file}'\r` }),
    { identity: cap(t), file }
  )
  const [owned] = await pids(file)
  const hostPid = await app.evaluate(
    ({ app }) => app.getAppMetrics().find((metric) => metric.name === 'Pi User Terminal Host')?.pid
  )
  expect(hostPid).toBeGreaterThan(1)
  // This exact utility was created by this fixture app and owns only fixture shells.
  process.kill(hostPid!, 'SIGKILL')
  await expect
    .poll(async () => {
      const result = await page.evaluate(
        (projectPath) => window.pi.terminal({ type: 'list', projectPath }),
        project
      )
      return result.type === 'list' && result.terminals[0]?.failure
    })
    .toBe('host-exit')
  const result = await page.evaluate(
    (projectPath) => window.pi.terminal({ type: 'list', projectPath }),
    project
  )
  expect(result).toMatchObject({ terminals: [{ state: 'failed', exitConfirmed: false }] })
  await expect.poll(() => alive(owned!)).toBe(false)
})

test('Pi agent crash does not revoke selected-project user terminal management', async () => {
  const t = await create()
  const workerId = await page.evaluate(
    async () => (await window.pi.getState()).desktopScope?.workerId
  )
  expect(workerId).toBeTruthy()
  const agentPid = await app.evaluate(
    ({ app }, workerId) =>
      app
        .getAppMetrics()
        .find(
          (metric) =>
            metric.name === `Pi Session Host ${workerId}` ||
            metric.serviceName === `Pi Session Host ${workerId}`
        )?.pid,
    workerId
  )
  expect(agentPid).toBeGreaterThan(1)
  process.kill(agentPid!, 'SIGKILL')
  await expect.poll(() => page.getByRole('button', { name: '重新连接引擎' }).count()).toBe(1)
  expect(
    await page.evaluate((projectPath) => window.pi.terminal({ type: 'list', projectPath }), project)
  ).toMatchObject({ type: 'list', terminals: [{ terminalId: t.terminalId }] })
  await create()
  expect(
    await page.evaluate((identity) => window.pi.terminal({ type: 'close', ...identity }), cap(t))
  ).toMatchObject({ type: 'terminal' })
})

test('actual asynchronous node-pty write failure is visible without leaking diagnostics', async () => {
  const t = await create()
  // The wrapper injects EIO into the real node-pty asynchronous fs.write callback.
  expect(
    await page.evaluate(
      (identity) => window.pi.terminal({ type: 'input', ...identity, data: 'never delivered' }),
      cap(t)
    )
  ).toEqual({ type: 'ok' })
  await expect
    .poll(async () => {
      const result = await page.evaluate(
        (projectPath) => window.pi.terminal({ type: 'list', projectPath }),
        project
      )
      return result.type === 'list' && result.terminals[0]?.failure
    })
    .toBe('host-io')
  await expect
    .poll(async () => {
      const result = await page.evaluate(
        (projectPath) => window.pi.terminal({ type: 'list', projectPath }),
        project
      )
      return result.type === 'list' && result.terminals[0]?.exitConfirmed
    })
    .toBe(true)
  expect(
    await page.evaluate((projectPath) => window.pi.terminal({ type: 'list', projectPath }), project)
  ).toMatchObject({ terminals: [{ state: 'failed', failure: 'host-io', exitConfirmed: true }] })
  expect(await page.evaluate(() => JSON.stringify(window.terminalBackendEvents))).not.toContain(
    'PRIVATE_TERMINAL_IO_FIXTURE_SENTINEL'
  )
})
