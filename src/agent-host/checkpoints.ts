import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  CheckpointFilePlan,
  CheckpointPlan,
  CheckpointRestoreOutcome,
  CheckpointTurnState
} from '../shared/checkpoints'

/** Files larger than this are not copied; their turn can only be partially restored. */
export const MAX_CHECKPOINT_FILE = 4 * 1024 * 1024
/** Post-images are only hashed, but reading unbounded files would stall the Host. */
const MAX_HASHED_FILE = 64 * 1024 * 1024
const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/

/** `null` means the path did not exist; `undefined` means the state is unknown. */
type Hash = string | null

type CheckpointRecord = {
  seq: number
  turn: string
  toolCallId: string
  path: string
  before: Hash
  after?: Hash
  omitted?: true
  restored?: true
}

type SessionCheckpoints = { records: CheckpointRecord[]; nextSeq: number }

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

/** Mirrors how Pi's write/edit tools resolve their `path` argument. */
export function resolveToolPath(input: string, cwd: string): string {
  let path = input.replace(UNICODE_SPACES, ' ')
  if (path.startsWith('@')) path = path.slice(1)
  if (path === '~') path = homedir()
  else if (path.startsWith('~/')) path = join(homedir(), path.slice(2))
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Pre-images of files Pi changes through write/edit, grouped by the user turn that caused
 * them. Restoring a turn rewinds every later tool change too, in reverse, because the disk
 * only has one timeline. Shell commands are not observed and are never undone.
 */
export class CheckpointStore {
  private sessions = new Map<string, SessionCheckpoints>()

  constructor(private readonly root: string) {}

  capture(sessionId: string, turn: string, toolCallId: string, path: string): void {
    const session = this.load(sessionId)
    if (!session) return
    const record: CheckpointRecord = {
      seq: session.nextSeq++,
      turn,
      toolCallId,
      path,
      before: null
    }
    try {
      const stat = lstatSync(path, { throwIfNoEntry: false })
      if (stat && (!stat.isFile() || stat.size > MAX_CHECKPOINT_FILE)) record.omitted = true
      else if (stat) record.before = this.storeBlob(sessionId, readFileSync(path))
    } catch {
      record.omitted = true
    }
    session.records.push(record)
    this.save(sessionId, session)
  }

  /** Records what the tool left behind, so later manual edits are detected as conflicts. */
  settle(sessionId: string, toolCallId: string): void {
    const session = this.load(sessionId)
    const record = session?.records.findLast(
      (item) => item.toolCallId === toolCallId && !item.restored
    )
    if (!session || !record) return
    const after = this.currentHash(record.path)
    if (after === record.before && !record.omitted) {
      // A failed or no-op call changed nothing and needs no undo.
      session.records = session.records.filter((item) => item !== record)
    } else if (after !== undefined) record.after = after
    this.save(sessionId, session)
  }

  turns(sessionId: string): CheckpointTurnState[] {
    const session = this.load(sessionId)
    if (!session) return []
    const turns = new Map<string, CheckpointTurnState>()
    for (const record of session.records) {
      const current = turns.get(record.turn)
      const state = record.restored ? 'restored' : 'available'
      turns.set(record.turn, {
        entryId: record.turn,
        state: current?.state === 'available' || state === 'available' ? 'available' : 'restored'
      })
    }
    return [...turns.values()]
  }

  plan(sessionId: string, turn: string): CheckpointPlan | null {
    const session = this.load(sessionId)
    if (!session) return null
    const active = session.records.filter((record) => !record.restored)
    const start = active.findIndex((record) => record.turn === turn)
    if (start < 0) return null
    const affected = active.slice(start)
    const byPath = new Map<string, CheckpointRecord[]>()
    for (const record of affected)
      byPath.set(record.path, [...(byPath.get(record.path) ?? []), record])
    const files: CheckpointFilePlan[] = []
    for (const [path, records] of byPath) {
      const first = records[0]
      const last = records.at(-1)!
      const expected = last.after
      const current = this.currentHash(path)
      files.push({
        path,
        action: first.before === null && !first.omitted ? 'delete' : 'restore',
        status: first.omitted
          ? 'uncaptured'
          : expected === undefined || current !== expected
            ? 'conflict'
            : 'ready'
      })
    }
    return {
      entryId: turn,
      laterTurns: new Set(affected.map((record) => record.turn).filter((id) => id !== turn)).size,
      files
    }
  }

  restore(sessionId: string, turn: string, force: boolean): CheckpointRestoreOutcome {
    const session = this.load(sessionId)
    const plan = this.plan(sessionId, turn)
    if (!session || !plan) return { status: 'unavailable' }
    if (!force && plan.files.some((file) => file.status === 'conflict'))
      return { status: 'conflict', plan }
    const active = session.records.filter((record) => !record.restored)
    const affected = active.slice(active.findIndex((record) => record.turn === turn))
    const failed: string[] = []
    let restored = 0
    for (const file of plan.files) {
      if (file.status === 'uncaptured') continue
      const first = affected.find((record) => record.path === file.path)!
      try {
        if (first.before === null) {
          const stat = lstatSync(file.path, { throwIfNoEntry: false })
          if (stat?.isDirectory()) throw new Error('path is now a directory')
          if (stat) rmSync(file.path, { force: true })
        } else {
          mkdirSync(dirname(file.path), { recursive: true })
          writeFileSync(file.path, readFileSync(this.blobPath(sessionId, first.before)))
        }
        restored++
      } catch {
        failed.push(file.path)
      }
    }
    // Failed paths keep their records so the user can resolve them and retry.
    for (const record of affected) if (!failed.includes(record.path)) record.restored = true
    this.save(sessionId, session)
    return {
      status: failed.length ? 'partial' : 'restored',
      restored,
      skipped: plan.files.filter((file) => file.status === 'uncaptured').map((file) => file.path),
      failed
    }
  }

  private currentHash(path: string): Hash | undefined {
    try {
      const stat = lstatSync(path, { throwIfNoEntry: false })
      if (!stat) return null
      if (!stat.isFile() || stat.size > MAX_HASHED_FILE) return undefined
      return sha256(readFileSync(path))
    } catch {
      return undefined
    }
  }

  private directory(sessionId: string): string {
    return join(this.root, sessionId)
  }

  private blobPath(sessionId: string, hash: string): string {
    return join(this.directory(sessionId), 'blobs', hash)
  }

  private storeBlob(sessionId: string, content: Buffer): string {
    const hash = sha256(content)
    const path = this.blobPath(sessionId, hash)
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true })
      writeAtomic(path, content)
    }
    return hash
  }

  private load(sessionId: string): SessionCheckpoints | null {
    if (!SAFE_ID.test(sessionId)) return null
    const cached = this.sessions.get(sessionId)
    if (cached) return cached
    let records: CheckpointRecord[] = []
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(this.directory(sessionId), 'records.json'), 'utf8')
      )
      if (Array.isArray(parsed)) records = parsed.filter(isRecord)
    } catch {
      records = []
    }
    const session = {
      records,
      nextSeq: records.reduce((max, record) => Math.max(max, record.seq + 1), 0)
    }
    this.sessions.set(sessionId, session)
    return session
  }

  private save(sessionId: string, session: SessionCheckpoints): void {
    const directory = this.directory(sessionId)
    mkdirSync(directory, { recursive: true })
    writeAtomic(join(directory, 'records.json'), JSON.stringify(session.records))
  }
}

function writeAtomic(path: string, content: string | Buffer): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function isRecord(value: unknown): value is CheckpointRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.seq === 'number' &&
    typeof record.turn === 'string' &&
    typeof record.toolCallId === 'string' &&
    typeof record.path === 'string' &&
    (record.before === null ||
      (typeof record.before === 'string' && /^[0-9a-f]{64}$/.test(record.before)))
  )
}
