// A development Electron gate, never the production application entry point.
const { app, utilityProcess } = require('electron')
const { mkdtempSync, mkdirSync, rmSync, realpathSync } = require('node:fs')
const { tmpdir, homedir } = require('node:os')
const { join, relative, isAbsolute, resolve } = require('node:path')
const { spawn } = require('node:child_process')

const fixtureArgument = process.argv.find((arg) => arg.startsWith('--pty-smoke-fixture='))
// Development harness only: no production entry or IPC accepts this switch.
const bundleArgument = process.argv.find((arg) => arg.startsWith('--bundle-resources='))
const bundleResources = bundleArgument
  ? resolve(bundleArgument.slice('--bundle-resources='.length))
  : null
const log = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

if (!fixtureArgument) {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'pi-pty-smoke-')))
  for (const directory of ['home', 'cwd', 'tmp', 'user-data', 'launcher-data'])
    mkdirSync(join(fixture, directory))
  // The bootstrap process also stays isolated if it reaches ready while waiting.
  app.setPath('userData', join(fixture, 'launcher-data'))
  app.setPath('sessionData', join(fixture, 'launcher-data'))
  // Relaunch before app.whenReady so native Electron path discovery sees the fixture HOME.
  const child = spawn(
    process.execPath,
    [
      __filename,
      `--pty-smoke-fixture=${fixture}`,
      `--user-data-dir=${join(fixture, 'user-data')}`,
      ...(bundleResources ? [`--bundle-resources=${bundleResources}`] : [])
    ],
    {
      cwd: join(fixture, 'cwd'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: join(fixture, 'home'),
        TMPDIR: join(fixture, 'tmp'),
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'en_US.UTF-8'
      }
    }
  )
  child.stdout.pipe(process.stdout)
  // Electron diagnostics may contain paths; only expose fixture-redacted output.
  child.stderr.on('data', (data) =>
    process.stderr.write(String(data).split(fixture).join('<fixture>'))
  )
  const deadline = setTimeout(() => child.kill('SIGTERM'), 45000)
  const hardDeadline = setTimeout(() => child.kill('SIGKILL'), 50000)
  let finished = false
  const finish = (code) => {
    if (finished) return
    finished = true
    clearTimeout(deadline)
    clearTimeout(hardDeadline)
    rmSync(fixture, { recursive: true, force: true })
    log({ fixtureCleanup: true, exitCode: code })
    app.exit(code)
  }
  child.once('error', () => finish(1))
  child.once('exit', (code) => finish(code ?? 1))
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill('SIGTERM'))
} else {
  const fixture = fixtureArgument.slice('--pty-smoke-fixture='.length)
  let host
  let done = false
  let resultCode = 1
  const underFixture = (path) => {
    const rel = relative(fixture, path)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }
  const deadline = setTimeout(() => {
    log({ failure: 'main-timeout' })
    if (host) host.postMessage({ type: 'shutdown' })
    else app.exit(1)
  }, 30000)
  const forceDeadline = setTimeout(() => {
    if (host) host.kill()
    app.exit(1)
  }, 35000)
  const finish = (code) => {
    if (done) return
    done = true
    clearTimeout(deadline)
    clearTimeout(forceDeadline)
    app.exit(code)
  }
  process.on('SIGTERM', () => {
    if (host) host.postMessage({ type: 'shutdown' })
    else finish(1)
  })
  void app
    .whenReady()
    .then(async () => {
      if (
        process.versions.electron !== '44.1.0' ||
        process.arch !== 'arm64' ||
        process.platform !== 'darwin'
      ) {
        throw new Error('unexpected-runtime')
      }
      // Do not even construct a store until its default directory is known safe.
      if (!underFixture(homedir()) || !underFixture(app.getPath('userData')))
        throw new Error('path-isolation-failed')
      const { default: Store } = await import('electron-store')
      const store = new Store({ name: 'pi-desktop-preferences' })
      const paths = {
        home: homedir(),
        appHome: app.getPath('home'),
        userData: app.getPath('userData'),
        preferences: store.path,
        agentDir: join(homedir(), '.pi', 'agent')
      }
      const isolation = Object.fromEntries(
        Object.entries(paths).map(([name, path]) => [name, underFixture(path)])
      )
      log({
        runtime: {
          electron: process.versions.electron,
          node: process.versions.node,
          modules: process.versions.modules,
          arch: process.arch,
          platform: process.platform
        },
        isolation,
        paths: Object.fromEntries(
          Object.entries(paths).map(([name, path]) => [
            name,
            underFixture(path) ? `<fixture>/${relative(fixture, path)}` : '<outside-fixture>'
          ])
        )
      })
      // app.getPath('home') remains the native account home on macOS. The fixture
      // never uses it; this limits the later production-bundle isolation claim.
      log({ packagedEntryIsolationProven: false, reason: 'native-app-home-outside-fixture' })
      if (['home', 'userData', 'preferences', 'agentDir'].some((key) => !isolation[key]))
        throw new Error('path-isolation-failed')
      log({
        acceptanceScope: bundleResources ? 'packaged-resources-only' : 'development-utility',
        productionEntryRun: false
      })
      host = utilityProcess.fork(
        join(__dirname, 'pty-smoke-host.cjs'),
        [fixture, ...(bundleResources ? [bundleResources] : [])],
        {
          cwd: join(fixture, 'cwd'),
          stdio: 'pipe',
          serviceName: 'Isolated PTY smoke',
          env: {
            HOME: join(fixture, 'home'),
            TMPDIR: join(fixture, 'tmp'),
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            LANG: 'en_US.UTF-8'
          }
        }
      )
      host.on('message', (message) => {
        log(message)
        if (message.type === 'result') resultCode = message.ok ? 0 : 1
        if (message.type === 'cleanup') host.postMessage({ type: 'cleanup-ack' })
      })
      // Raw host output/errors are deliberately not forwarded (no environment/stack dumps).
      host.stdout.on('data', () => {})
      host.stderr.on('data', () => {})
      host.once('exit', (code) => finish(code === 0 ? resultCode : 1))
    })
    .catch((error) => {
      log({ failure: error.code || error.message })
      finish(1)
    })
}
