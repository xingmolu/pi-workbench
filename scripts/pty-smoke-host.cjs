const { join, relative, dirname, resolve } = require('node:path')
const { accessSync, constants, statSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { homedir } = require('node:os')
const fixture = process.argv[2]
const bundleResources = process.argv[3]
const send = (message) => process.parentPort.postMessage(message)
const sessions = new Set()
let stopping = false
let cleanupExitCode = 1

async function cleanup() {
  if (stopping) return
  stopping = true
  for (const session of sessions) {
    if (!session.exit) {
      try {
        session.pty.kill()
      } catch {}
    }
  }
  // These fixtures create no detached jobs. kill() is not a process-tree guarantee.
  const end = Date.now() + 2000
  while ([...sessions].some((session) => !session.exit) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const remaining = [...sessions].filter((session) => !session.exit).length
  cleanupExitCode = remaining ? 1 : process.exitCode || 0
  send({ type: 'cleanup', ownedPtysAwaitingExit: remaining, detachedDaemonGuarantee: false })
  // Wait for Main to observe cleanup and the preceding result before exiting.
  setTimeout(() => process.exit(1), 1000)
}
process.parentPort.on('message', ({ data }) => {
  if (data.type === 'shutdown') {
    process.exitCode = 1
    void cleanup()
  }
  if (data.type === 'cleanup-ack' && stopping) process.exit(cleanupExitCode)
})
process.on('SIGTERM', () => {
  process.exitCode = 1
  void cleanup()
})
process.on('uncaughtException', () => {
  send({ type: 'result', ok: false, failure: 'uncaught-host-error' })
  process.exitCode = 1
  void cleanup()
})
const watchdog = setTimeout(() => {
  process.exitCode = 1
  void cleanup()
}, 25000)

void (async () => {
  // An absolute package entry prevents Node from falling back to the workspace.
  const packageRoot = bundleResources
    ? join(bundleResources, 'app.asar', 'node_modules', 'node-pty')
    : dirname(require.resolve('node-pty/package.json'))
  const pty = require(packageRoot)
  if (homedir() !== join(fixture, 'home')) throw new Error('utility-home-isolation')
  const nativePaths = Object.keys(require.cache).filter((path) => path.endsWith('/pty.node'))
  if (nativePaths.length !== 1) throw new Error('ambiguous-native-load')
  const nativePath = nativePaths[0]
  if (!nativePath.startsWith(packageRoot + '/')) throw new Error('native-outside-selected-package')
  const nativeDiskPath = nativePath.replace('app.asar/', 'app.asar.unpacked/')
  // node-pty 1.1.0 derives spawn-helper from the successful loader directory.
  const helperPath = join(dirname(nativeDiskPath), 'spawn-helper')
  const version = require(join(packageRoot, 'package.json')).version
  if (version !== '1.1.0') throw new Error('unexpected-node-pty-version')
  for (const path of [nativeDiskPath, helperPath]) {
    if (execFileSync('/usr/bin/lipo', ['-archs', path], { encoding: 'utf8' }).trim() !== 'arm64')
      throw new Error('unexpected-native-architecture')
  }
  accessSync(helperPath, constants.X_OK)
  if (
    bundleResources &&
    !nativeDiskPath.startsWith(resolve(bundleResources, 'app.asar.unpacked') + '/')
  )
    throw new Error('native-not-unpacked')
  send({
    type: 'native',
    version,
    arch: process.arch,
    electron: process.versions.electron,
    nativePaths: nativePaths.map((path) =>
      relative(bundleResources || join(__dirname, '..'), path)
    ),
    helperPath: relative(bundleResources || join(__dirname, '..'), helperPath),
    nativeMode: (statSync(nativeDiskPath).mode & 0o777).toString(8),
    helperMode: (statSync(helperPath).mode & 0o777).toString(8),
    nativeArchitecture: 'arm64',
    helperArchitecture: 'arm64',
    bundleResourcesOnly: Boolean(bundleResources)
  })
  const options = {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: join(fixture, 'cwd'),
    env: {
      HOME: join(fixture, 'home'),
      ZDOTDIR: join(fixture, 'home'),
      TMPDIR: join(fixture, 'tmp'),
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      PS1: '',
      PS2: ''
    }
  }
  function create(shell, args) {
    const session = { pty: pty.spawn(shell, args, options), output: '', exit: null }
    sessions.add(session)
    session.pty.onData((data) => {
      session.output += data
      if (Buffer.byteLength(session.output) > 65536) throw new Error('smoke-output-budget')
    })
    session.pty.onExit((event) => {
      session.exit = event
    })
    return session
  }
  async function until(predicate, label) {
    const end = Date.now() + 4000
    while (!predicate()) {
      if (stopping || Date.now() >= end) throw new Error(`timeout-${label}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const shell = create('/bin/zsh', ['-f'])
  const nonce = randomBytes(12).toString('hex')
  // Marker text is assembled by printf, so command echo cannot satisfy any assertion.
  async function command(body, expected, label) {
    const marker = `${nonce}:${label}:${expected}`
    shell.output = ''
    shell.pty.write(`${body}\r`)
    await until(() => shell.output.split(/\r?\n/).includes(marker), label)
    send({ type: 'check', name: label, ok: true })
  }
  await command(
    `/bin/stty -echo; [[ -t 0 && -t 1 && -t 2 ]] && printf '%s:%s:%s\\n' '${nonce}' 'tty' 'yes'`,
    'yes',
    'tty'
  )
  await command(`printf '%s:%s:%s%s\\n' '${nonce}' 'utf8' '中文' '回显'`, '中文回显', 'utf8')
  shell.pty.resize(103, 37)
  await command(`printf '%s:%s:%s\\n' '${nonce}' 'resize' "$(/bin/stty size)"`, '37 103', 'resize')
  // Busy shell builtin is deterministic and creates no child that could outlive cleanup.
  shell.output = ''
  shell.pty.write(`printf '%s:%s\\n' '${nonce}' 'interrupt-ready'; while true; do :; done\r`)
  await until(
    () => shell.output.split(/\r?\n/).includes(`${nonce}:interrupt-ready`),
    'interrupt-ready'
  )
  shell.pty.write('\x03')
  await command(
    `printf '%s:%s:%s\\n' '${nonce}' 'ctrl-c-continued' 'yes'`,
    'yes',
    'ctrl-c-continued'
  )
  shell.pty.write('exit 7\r')
  await until(() => shell.exit !== null, 'natural-exit')
  if (shell.exit.exitCode !== 7 || shell.exit.signal) throw new Error('natural-exit-status')
  send({ type: 'check', name: 'natural-exit', ok: true, ...shell.exit })
  let invalid
  try {
    invalid = create(join(fixture, 'missing-shell'), [])
  } catch (error) {
    // node-pty may reject synchronously, or its helper may report a nonzero exit.
    if (!/posix_spawnp|ENOENT|not found/i.test(error.message))
      throw new Error('unexpected-invalid-shell-error')
    send({ type: 'check', name: 'invalid-shell', ok: true, classification: 'spawn-rejected' })
  }
  if (invalid) {
    await until(() => invalid.exit !== null, 'invalid-shell')
    if (invalid.exit.exitCode === 0) throw new Error('invalid-shell-succeeded')
    send({
      type: 'check',
      name: 'invalid-shell',
      ok: true,
      classification: 'nonzero-exit',
      ...invalid.exit
    })
  }
  send({ type: 'result', ok: true, checks: 6 })
})()
  .catch((error) => {
    send({
      type: 'result',
      ok: false,
      failure: error.code === 'MODULE_NOT_FOUND' ? 'MODULE_NOT_FOUND:node-pty' : error.message
    })
    process.exitCode = 1
  })
  .finally(() => {
    clearTimeout(watchdog)
    void cleanup()
  })
