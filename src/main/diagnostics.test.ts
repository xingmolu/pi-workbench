import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Diagnostics, redact } from './diagnostics'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('strips keys, tokens and the home directory', () => {
  const text = [
    'key sk-ant-api03-abcdefghijklmnop failed',
    'pat github_pat_11ABCDEFGHIJKLMNOPQRS',
    'Authorization: Bearer abcdef.ghijkl.mnopqr',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig',
    '{"apiKey":"plain-secret","refresh_token":"r-123456"}',
    'opened /home/robin/project/file.ts'
  ].join('\n')
  const out = redact(text, '/home/robin')
  expect(out).not.toMatch(
    /abcdefghijklmnop|11ABCDEFGHIJ|abcdef\.ghijkl|plain-secret|r-123456|robin/
  )
  expect(out).toContain('~/project/file.ts')
  expect(out).toContain('<jwt>')
})

it('keeps console output, logs warnings and errors, records crashes and builds a report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostics-'))
  roots.push(root)
  const diagnostics = new Diagnostics(root)
  const seen: unknown[][] = []
  const target = {
    warn: (...args: unknown[]) => void seen.push(args),
    error: (...args: unknown[]) => void seen.push(args)
  }
  diagnostics.capture(target)
  target.warn('Engine download failed (codex):', 'HTTP 503')
  target.error(new Error('boom sk-live-1234567890abcdef'))
  diagnostics.crash({ kind: 'utility', name: 'codex-host', reason: 'crashed', exitCode: 11 })
  expect(seen).toHaveLength(2)
  expect(diagnostics.crashes()).toMatchObject([{ kind: 'utility', reason: 'crashed' }])
  const report = diagnostics.report({ 版本: '0.1.0', 系统: 'linux x64' })
  expect(report).toContain('Engine download failed (codex): HTTP 503')
  expect(report).toContain('utility (codex-host): crashed exit 11')
  expect(report).toContain('- 版本: 0.1.0')
  expect(report).not.toContain('1234567890abcdef')
})

it('rotates the log once it passes a megabyte', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diagnostics-'))
  roots.push(root)
  const diagnostics = new Diagnostics(root)
  await writeFile(diagnostics.logFile, 'x'.repeat(1024 * 1024 + 1))
  diagnostics.log('warn', ['after rotation'])
  expect(statSync(`${diagnostics.logFile}.1`).size).toBeGreaterThan(1024 * 1024)
  expect(statSync(diagnostics.logFile).size).toBeLessThan(200)
})
