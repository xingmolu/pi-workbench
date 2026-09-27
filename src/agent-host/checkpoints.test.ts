import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckpointStore, MAX_CHECKPOINT_FILE, resolveToolPath } from './checkpoints'

let root: string
let work: string
let store: CheckpointStore
const S = 'session-1'

function write(name: string, content: string): string {
  const path = join(work, name)
  writeFileSync(path, content)
  return path
}

/** Simulates one Pi write/edit call: capture, mutate, settle. */
function tool(turn: string, id: string, path: string, content: string | null): void {
  store.capture(S, turn, id, path)
  if (content === null) rmSync(path, { force: true })
  else writeFileSync(path, content)
  store.settle(S, id)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-checkpoints-'))
  work = join(root, 'work')
  store = new CheckpointStore(join(root, 'store'))
  mkdirSync(work)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('checkpoint store', () => {
  it('restores edited files and deletes files the turn created', () => {
    const a = write('a.ts', 'one')
    const b = join(work, 'b.ts')
    tool('t1', 'c1', a, 'two')
    tool('t1', 'c2', b, 'new file')
    expect(store.turns(S)).toEqual([{ entryId: 't1', state: 'available' }])
    expect(store.plan(S, 't1')?.files).toEqual([
      { path: a, action: 'restore', status: 'ready' },
      { path: b, action: 'delete', status: 'ready' }
    ])
    expect(store.restore(S, 't1', false)).toMatchObject({ status: 'restored', restored: 2 })
    expect(readFileSync(a, 'utf8')).toBe('one')
    expect(existsSync(b)).toBe(false)
    expect(store.turns(S)).toEqual([{ entryId: 't1', state: 'restored' }])
    expect(store.plan(S, 't1')).toBeNull()
  })

  it('rewinds later turns too, using the earliest pre-image per file', () => {
    const a = write('a.ts', 'v0')
    tool('t1', 'c1', a, 'v1')
    tool('t2', 'c2', a, 'v2')
    expect(store.plan(S, 't1')).toMatchObject({ laterTurns: 1 })
    store.restore(S, 't1', false)
    expect(readFileSync(a, 'utf8')).toBe('v0')
    expect(store.turns(S).map((turn) => turn.state)).toEqual(['restored', 'restored'])
  })

  it('restoring a later turn leaves earlier turns available', () => {
    const a = write('a.ts', 'v0')
    tool('t1', 'c1', a, 'v1')
    tool('t2', 'c2', a, 'v2')
    store.restore(S, 't2', false)
    expect(readFileSync(a, 'utf8')).toBe('v1')
    expect(store.turns(S)).toEqual([
      { entryId: 't1', state: 'available' },
      { entryId: 't2', state: 'restored' }
    ])
  })

  it('refuses to overwrite manual edits unless forced', () => {
    const a = write('a.ts', 'v0')
    tool('t1', 'c1', a, 'v1')
    writeFileSync(a, 'edited by hand')
    const outcome = store.restore(S, 't1', false)
    expect(outcome).toMatchObject({ status: 'conflict' })
    expect(readFileSync(a, 'utf8')).toBe('edited by hand')
    expect(store.restore(S, 't1', true)).toMatchObject({ status: 'restored' })
    expect(readFileSync(a, 'utf8')).toBe('v0')
  })

  it('drops no-op calls and reports oversized files as uncaptured', () => {
    const a = write('a.ts', 'same')
    tool('t1', 'c1', a, 'same')
    expect(store.turns(S)).toEqual([])
    const big = write('big.bin', 'x'.repeat(MAX_CHECKPOINT_FILE + 1))
    tool('t2', 'c2', big, 'small')
    expect(store.plan(S, 't2')?.files).toEqual([
      { path: big, action: 'restore', status: 'uncaptured' }
    ])
    expect(store.restore(S, 't2', false)).toMatchObject({ status: 'restored', skipped: [big] })
    expect(readFileSync(big, 'utf8')).toBe('small')
  })

  it('persists across store instances and ignores unsafe session IDs', () => {
    const a = write('a.ts', 'v0')
    tool('t1', 'c1', a, 'v1')
    const reopened = new CheckpointStore(join(root, 'store'))
    expect(reopened.restore(S, 't1', false)).toMatchObject({ status: 'restored' })
    expect(readFileSync(a, 'utf8')).toBe('v0')
    store.capture('../escape', 't', 'c', a)
    expect(existsSync(join(root, 'escape'))).toBe(false)
    expect(store.turns('../escape')).toEqual([])
  })

  it('resolves tool paths the way Pi does', () => {
    expect(resolveToolPath('src/a.ts', '/p')).toBe('/p/src/a.ts')
    expect(resolveToolPath('@src/a.ts', '/p')).toBe('/p/src/a.ts')
    expect(resolveToolPath('/abs/a.ts', '/p')).toBe('/abs/a.ts')
    expect(resolveToolPath('~/a.ts', '/p')).toMatch(/\/a\.ts$/)
  })
})
