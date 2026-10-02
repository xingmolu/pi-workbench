import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { autoApproves } from './host'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

it('"帮我批准" runs reads and project edits, and asks for edits elsewhere and for WebFetch', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-auto-'))
  roots.push(root)
  const project = join(root, 'project')
  mkdirSync(join(project, 'src'), { recursive: true })
  symlinkSync(root, join(project, 'escape'))

  expect(autoApproves('Read', { file_path: '/etc/hosts' }, project)).toBe(true)
  expect(autoApproves('Grep', { pattern: 'x' }, project)).toBe(true)
  expect(autoApproves('WebSearch', { query: 'docs' }, project)).toBe(true)
  expect(autoApproves('WebFetch', { url: 'https://example.com' }, project)).toBe(false)

  expect(autoApproves('Write', { file_path: join(project, 'src/a.ts') }, project)).toBe(true)
  expect(autoApproves('Edit', { file_path: 'src/a.ts' }, project)).toBe(true)
  expect(autoApproves('NotebookEdit', { notebook_path: 'n.ipynb' }, project)).toBe(true)
  expect(autoApproves('Write', { file_path: join(root, '.bashrc') }, project)).toBe(false)
  expect(autoApproves('Edit', { file_path: '../outside.txt' }, project)).toBe(false)
  // A link inside the project that leads outside it is not a project file.
  expect(autoApproves('Write', { file_path: 'escape/x.txt' }, project)).toBe(false)
  expect(autoApproves('Write', { file_path: 'src/a.ts' }, undefined)).toBe(false)
  expect(autoApproves('Bash', { command: 'ls' }, project)).toBe(false)
})
