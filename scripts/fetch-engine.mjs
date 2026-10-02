// Downloads one pinned engine CLI for this machine, verifies it against the sha512 pinned in
// src/shared/engine-binaries.generated.ts, unpacks it and prints the executable's path.
// CI uses it to run the real Codex / Claude Code tests:
//
//   PI_DESKTOP_CODEX_EXECUTABLE="$(node scripts/fetch-engine.mjs codex .engines)"
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const [engine, target = '.engines'] = process.argv.slice(2)
if (engine !== 'codex' && engine !== 'claude')
  throw new Error('usage: fetch-engine.mjs <codex|claude> [directory]')

const text = await readFile(join(repo, 'src/shared/engine-binaries.generated.ts'), 'utf8')
// The generated file is a formatted object literal (keys may be unquoted).
const pins = new Function(`return ${text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)}`)()
const key = `${process.platform}-${process.arch}`
const pin = pins[engine].platforms[key]
if (!pin) throw new Error(`${engine} has no pinned build for ${key}`)

const directory = resolve(target, engine, pins[engine].version)
const executable = join(directory, pin.root, pin.executable)
if (!existsSync(executable)) {
  const response = await fetch(pin.tarball)
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  const [algorithm, expected] = pin.integrity.split('-', 2)
  if (createHash(algorithm).update(archive).digest('base64') !== expected)
    throw new Error(`${engine} download does not match its pinned digest`)
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'archive.tgz')
  await writeFile(file, archive)
  // A relative name: GNU tar reads `C:\…` as a remote host.
  execFileSync('tar', ['-xzf', 'archive.tgz'], { cwd: directory })
  await rm(file)
}
process.stdout.write(executable)
