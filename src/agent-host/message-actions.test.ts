import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { recordMessageFeedback } from './message-actions'
import { projectSessionHistory } from './session-history'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) fs.rmSync(path, { recursive: true, force: true })
})
function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pi-feedback-'))
  directories.push(directory)
  const manager = SessionManager.create(directory, directory)
  manager.appendMessage({ role: 'user', content: 'question', timestamp: 1 })
  const entryId = manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'answer' }],
    api: 'openai-completions',
    provider: 'fixture',
    model: 'offline',
    stopReason: 'stop',
    timestamp: 2,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
  })
  const target = {
    type: 'message:feedback' as const,
    sessionId: manager.getSessionId(),
    generation: 1,
    entryId,
    value: 'up' as const
  }
  const state = { manager, sessionId: target.sessionId, generation: 1, reason: null }
  return { manager, target, state }
}
it('persists public custom feedback, reopens latest value, avoids duplicate writes and never enters model context', () => {
  const f = fixture()
  recordMessageFeedback(f.target, f.state)
  const bytes = fs.readFileSync(f.manager.getSessionFile()!)
  recordMessageFeedback(f.target, f.state)
  expect(fs.readFileSync(f.manager.getSessionFile()!)).toEqual(bytes)
  recordMessageFeedback({ ...f.target, value: 'down' }, f.state)
  const reopened = SessionManager.open(f.manager.getSessionFile()!)
  expect(
    projectSessionHistory(reopened.getBranch()).find((n) => n.type === 'assistant')
  ).toMatchObject({ feedback: 'down' })
  expect(JSON.stringify(reopened.buildSessionContext().messages)).not.toContain('message-feedback')
  expect(reopened.buildSessionContext().messages).toHaveLength(2)
  recordMessageFeedback({ ...f.target, value: null }, f.state)
  expect(
    projectSessionHistory(f.manager.getBranch()).find((n) => n.type === 'assistant')
  ).toMatchObject({ feedback: null })
})
it('rejects stale identities, nonassistant and offbranch entries, and busy state without writing', () => {
  const f = fixture(),
    before = fs.readFileSync(f.manager.getSessionFile()!)
  for (const target of [
    { ...f.target, generation: 2 },
    { ...f.target, sessionId: 'other' },
    { ...f.target, entryId: 'missing' },
    { ...f.target, entryId: f.manager.getBranch()[0]!.id }
  ])
    expect(() => recordMessageFeedback(target, f.state)).toThrow()
  expect(() => recordMessageFeedback(f.target, { ...f.state, reason: 'busy' })).toThrow('busy')
  expect(fs.readFileSync(f.manager.getSessionFile()!)).toEqual(before)
  f.manager.branch(f.manager.getBranch()[0]!.id)
  expect(() => recordMessageFeedback(f.target, f.state)).toThrow()
})
it('actual SDK persistence failure marks runtime unsafe instead of reporting success', () => {
  const f = fixture(),
    before = fs.readFileSync(f.manager.getSessionFile()!)
  const injected = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
    throw new Error('fixture disk error')
  })
  syncBuiltinESMExports()
  try {
    expect(() => recordMessageFeedback(f.target, f.state)).toThrow('重新连接')
  } finally {
    injected.mockRestore()
    syncBuiltinESMExports()
  }
  expect(fs.readFileSync(f.manager.getSessionFile()!)).toEqual(before)
  expect(f.manager.getBranch().at(-1)?.type).toBe('custom')
})
