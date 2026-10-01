import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { EngineBinaries } from './engine-binaries'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function header(name: string, size: number, type: string, mode = 0o644): Buffer {
  const block = Buffer.alloc(512)
  block.write(name.slice(0, 100), 0)
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100)
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  block.write(type, 156)
  block.write('ustar\0', 257)
  block.write('        ', 148)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return block
}
const pad = (data: Buffer): Buffer =>
  Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)])
function entry(name: string, content: string, mode = 0o644): Buffer {
  const data = Buffer.from(content)
  const long =
    name.length > 100
      ? Buffer.concat([
          header('././@LongLink', name.length + 1, 'L'),
          pad(Buffer.from(`${name}\0`))
        ])
      : Buffer.alloc(0)
  return Buffer.concat([long, header(name, data.length, '0', mode), pad(data)])
}
function tarball(entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
}
const integrity = (data: Buffer): string =>
  `sha512-${createHash('sha512').update(data).digest('base64')}`

async function setup(archive: Buffer, pinnedIntegrity = integrity(archive)) {
  const root = await mkdtemp(join(tmpdir(), 'engine-binaries-'))
  roots.push(root)
  const deep = `${'nested/'.repeat(20)}deep.txt`
  const pins = {
    claude: { version: '1.0.0', platforms: {} },
    codex: {
      version: '9.9.9',
      platforms: {
        'linux-x64': {
          tarball: 'https://registry.example/codex.tgz',
          integrity: pinnedIntegrity,
          size: archive.length,
          root: 'package/vendor/x/',
          executable: 'bin/codex',
          skip: ['voice/']
        }
      }
    }
  }
  let changes = 0
  const binaries = new EngineBinaries({
    root,
    platform: 'linux',
    arch: 'x64',
    pins,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            // Small chunks exercise headers and bodies split across reads.
            for (let index = 0; index < archive.length; index += 300)
              controller.enqueue(archive.subarray(index, index + 300))
            controller.close()
          }
        })
      ),
    onChange: () => (changes += 1)
  })
  return { root, binaries, deep, changes: () => changes }
}

it('downloads, verifies and unpacks only the pinned build for this platform', async () => {
  const deep = `${'nested/'.repeat(20)}deep.txt`
  const archive = tarball([
    entry('package/vendor/x/bin/codex', '#!/bin/sh\necho codex\n', 0o755),
    entry(`package/vendor/x/${deep}`, 'long name'),
    entry('package/vendor/x/voice/huge.bin', 'skipped'),
    entry('package/README.md', 'outside the root')
  ])
  const { root, binaries, changes } = await setup(archive)
  expect(binaries.status('codex')).toMatchObject({ state: 'missing', size: archive.length })
  expect(binaries.status('claude')).toMatchObject({ state: 'unsupported' })
  expect(binaries.executable('codex')).toBeUndefined()
  await Promise.all([binaries.install('codex'), binaries.install('codex')])
  const executable = binaries.executable('codex')!
  expect(executable).toBe(join(root, 'codex', '9.9.9', 'bin', 'codex'))
  expect(statSync(executable).mode & 0o111).not.toBe(0)
  expect(await readFile(join(root, 'codex', '9.9.9', deep), 'utf8')).toBe('long name')
  expect(existsSync(join(root, 'codex', '9.9.9', 'voice'))).toBe(false)
  expect(existsSync(join(root, 'codex', '9.9.9', 'README.md'))).toBe(false)
  expect(binaries.status('codex')).toMatchObject({ state: 'ready', source: 'downloaded' })
  expect(changes()).toBeGreaterThan(1)
  await binaries.remove('codex')
  expect(binaries.status('codex').state).toBe('missing')
})

it('discards a download that does not match the pinned digest', async () => {
  const archive = tarball([entry('package/vendor/x/bin/codex', 'tampered', 0o755)])
  const { root, binaries } = await setup(archive, integrity(Buffer.from('original')))
  await expect(binaries.install('codex')).rejects.toThrow('校验失败')
  expect(binaries.status('codex')).toMatchObject({ state: 'error' })
  expect(existsSync(join(root, 'codex', '9.9.9'))).toBe(false)
})

it('refuses archives whose paths escape the install directory', async () => {
  const archive = tarball([entry('package/vendor/x/../../../escape', 'nope', 0o755)])
  const { root, binaries } = await setup(archive)
  await expect(binaries.install('codex')).rejects.toThrow('越界')
  expect(existsSync(join(root, 'escape'))).toBe(false)
})
