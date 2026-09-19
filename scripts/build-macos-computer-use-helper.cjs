const { spawnSync } = require('node:child_process')
const { mkdirSync, chmodSync } = require('node:fs')
const { join } = require('node:path')

if (process.platform !== 'darwin') {
  console.log('Skipping macOS Computer Use helper build on non-macOS host.')
  process.exit(0)
}

const root = join(__dirname, '..')
const source = join(root, 'native', 'macos', 'ComputerUseBridge.swift')
const outDir = join(root, 'resources', 'native')
const output = join(outDir, 'pi-computer-use-helper')
mkdirSync(outDir, { recursive: true })

const result = spawnSync(
  'xcrun',
  [
    'swiftc',
    source,
    '-O',
    '-framework',
    'AppKit',
    '-framework',
    'ApplicationServices',
    '-o',
    output
  ],
  { cwd: root, stdio: 'inherit' }
)

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}
chmodSync(output, 0o755)
console.log(`Built macOS Computer Use helper: ${output}`)
