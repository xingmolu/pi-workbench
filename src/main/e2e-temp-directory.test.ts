import { chmod, mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertE2EModeAllowed,
  canonicalExistingTempDirectory,
  resolveAgentDirectory
} from './e2e-temp-directory'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('canonicalExistingTempDirectory', () => {
  it('returns the canonical path for a real directory inside the allowed temp root', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-desktop-path-test-')))
    cleanup.push(root)
    const allowedRoot = join(root, 'allowed-root')
    const directory = join(allowedRoot, 'agent')
    await mkdir(directory, { recursive: true })
    await chmod(allowedRoot, 0o700)

    expect(canonicalExistingTempDirectory(directory, 'TEST_PATH', allowedRoot)).toBe(directory)
  })

  it('rejects a symlink inside temp whose canonical target escapes the allowed root', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-desktop-path-test-')))
    cleanup.push(root)
    const allowedRoot = join(root, 'allowed-root')
    const outside = join(root, 'outside')
    const escape = join(allowedRoot, 'escape')
    await Promise.all([mkdir(allowedRoot), mkdir(outside)])
    await chmod(allowedRoot, 0o700)
    await symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() => canonicalExistingTempDirectory(escape, 'TEST_PATH', allowedRoot)).toThrow(
      '不能通过符号链接逃逸'
    )
  })
})

describe('assertE2EModeAllowed', () => {
  it('rejects packaged E2E before a hostile TMPDIR can influence path validation', () => {
    const previousTmpDir = process.env.TMPDIR
    process.env.TMPDIR = '/hostile/nonexistent/tmpdir'
    try {
      expect(() => assertE2EModeAllowed(true, true)).toThrow('已打包的生产应用')
    } finally {
      if (previousTmpDir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpDir
    }
  })

  it('allows the unpackaged test harness and normal packaged production', () => {
    expect(() => assertE2EModeAllowed(true, false)).not.toThrow()
    expect(() => assertE2EModeAllowed(false, true)).not.toThrow()
  })
})

describe('resolveAgentDirectory', () => {
  it('keeps production fixed under home and ignores an override', () => {
    expect(
      resolveAgentDirectory({
        e2eMode: false,
        override: '/tmp/ignored-agent',
        homeDirectory: '/production-home'
      })
    ).toBe('/production-home/.pi/agent')
  })

  it('resolves the actual production location to ~/.pi/agent', () => {
    expect(resolveAgentDirectory({ e2eMode: false, override: '/tmp/ignored-agent' })).toBe(
      join(homedir(), '.pi', 'agent')
    )
  })
})
