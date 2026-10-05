import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionRulesStore } from './permission-rules-store'

let root: string
let project: string
let file: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-rules-'))
  project = join(root, 'project')
  mkdirSync(join(project, 'src'), { recursive: true })
  file = join(root, 'permissions.json')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('permission rules store', () => {
  it('allows only matching commands for the project that owns the rule', () => {
    const store = new PermissionRulesStore(file)
    store.set(project, { commands: ['npm test'], projectEdits: false })
    expect(store.allows(project, 'bash', { command: 'npm test' }, project)).toBe(true)
    expect(store.allows(project, 'bash', { command: 'npm test && rm x' }, project)).toBe(false)
    expect(store.allows(join(root, 'other'), 'bash', { command: 'npm test' }, project)).toBe(false)
    expect(store.allows(project, 'write', { path: 'a.ts' }, project)).toBe(false)
  })

  it('allows project edits inside the project, not outside or through symlinks', () => {
    const store = new PermissionRulesStore(file)
    store.set(project, { commands: [], projectEdits: true })
    expect(store.allows(project, 'edit', { path: 'src/a.ts' }, project)).toBe(true)
    expect(store.allows(project, 'write', { path: 'new/dir/a.ts' }, project)).toBe(true)
    expect(store.allows(project, 'write', { path: '../escape.ts' }, project)).toBe(false)
    expect(store.allows(project, 'write', { path: join(root, 'x.ts') }, project)).toBe(false)
    mkdirSync(join(root, 'outside'))
    symlinkSync(join(root, 'outside'), join(project, 'link'))
    expect(store.allows(project, 'write', { path: 'link/a.ts' }, project)).toBe(false)
    expect(store.allows(project, 'bash', { command: 'ls' }, project)).toBe(false)
  })

  it('always allows only the Computer Use apps saved for the project, once each', () => {
    const store = new PermissionRulesStore(file)
    store.set(project, {
      commands: [],
      projectEdits: false,
      computerApps: [
        { bundleId: 'com.apple.finder', app: 'Finder' },
        { bundleId: 'com.apple.finder', app: 'Finder' }
      ]
    })
    expect(store.get(project).computerApps).toEqual([
      { bundleId: 'com.apple.finder', app: 'Finder' }
    ])
    expect(store.allowsComputerApp(project, 'com.apple.finder')).toBe(true)
    expect(store.allowsComputerApp(project, 'com.apple.Terminal')).toBe(false)
    expect(store.allowsComputerApp(join(root, 'other'), 'com.apple.finder')).toBe(false)
    expect(store.allowsComputerApp(project, '')).toBe(false)
    store.set(project, { commands: [], projectEdits: false, computerApps: [] })
    expect(store.allowsComputerApp(project, 'com.apple.finder')).toBe(false)
  })

  it('shares changes between stores and ignores malformed entries', () => {
    const a = new PermissionRulesStore(file)
    const b = new PermissionRulesStore(file)
    expect(b.get(project).commands).toEqual([])
    a.set(project, { commands: ['git status'], projectEdits: false })
    expect(b.get(project).commands).toEqual(['git status'])
    writeFileSync(
      file,
      JSON.stringify({ projects: { [project]: { commands: ['a;b'], projectEdits: true } } })
    )
    expect(new PermissionRulesStore(file).get(project)).toEqual({
      commands: [],
      projectEdits: false
    })
  })

  it('remembers the approval level per project and applies auto only when asked', () => {
    const store = new PermissionRulesStore(file)
    expect(store.mode(project)).toBe('ask')
    store.setMode(project, 'open')
    expect(new PermissionRulesStore(file).mode(project)).toBe('open')
    expect(new PermissionRulesStore(file).mode(join(root, 'other'))).toBe('ask')
    store.setMode(project, 'auto')
    expect(store.mode(project)).toBe('auto')
    expect(store.allows(project, 'edit', { path: 'src/a.ts' }, project)).toBe(false)
    expect(store.allows(project, 'edit', { path: 'src/a.ts' }, project, true)).toBe(true)
    expect(store.allows(project, 'edit', { path: '../a.ts' }, project, true)).toBe(false)
    expect(store.allows(project, 'bash', { command: 'git status' }, project, true)).toBe(true)
    expect(store.allows(project, 'bash', { command: 'git push' }, project, true)).toBe(false)
    expect(store.allows(project, 'browser', { action: 'click' }, project, true)).toBe(false)
  })
})
