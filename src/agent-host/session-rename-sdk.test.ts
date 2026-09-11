import { describe, expect, it } from 'vitest'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { mkdtempSync, mkdirSync, renameSync, rmdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  renameSession,
  SessionPersistenceGuard,
  SessionRenamePersistenceError
} from './session-rename'

describe('SDK session rename persistence failure', () => {
  it('blocks poisoned memory and retries only from reopened canonical data', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-rename-failure-'))
    try {
      const manager = SessionManager.create(directory, directory)
      manager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'preserved reply' }],
        api: 'openai-responses',
        provider: 'openai',
        model: 'test-model',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop',
        timestamp: 1
      })
      manager.appendSessionInfo('old name')
      const sessionFile = manager.getSessionFile()!
      const backup = join(directory, 'backup.jsonl')
      const command = { sessionId: manager.getSessionId(), generation: 4, name: 'new name' }
      const target = () => ({
        ...command,
        persisted: true,
        busy: false,
        promptPending: false,
        currentName: manager.getSessionName()
      })
      const guard = new SessionPersistenceGuard()
      let attempts = 0
      const operations = {
        setSessionName: (name: string) => {
          attempts++
          // Real SDK append mutates indexes, then appendFileSync fails on this directory.
          renameSync(sessionFile, backup)
          mkdirSync(sessionFile)
          try {
            manager.appendSessionInfo(name)
          } finally {
            rmdirSync(sessionFile)
            renameSync(backup, sessionFile)
          }
        },
        refreshSessions: async () => true
      }
      await expect(
        guard.run(() => renameSession(command, target(), operations))
      ).rejects.toBeInstanceOf(SessionRenamePersistenceError)
      expect(manager.getSessionName()).toBe('new name')
      await expect(
        guard.run(() => renameSession(command, target(), operations))
      ).rejects.toBeInstanceOf(SessionRenamePersistenceError)
      expect(attempts).toBe(1)
      const reopened = SessionManager.open(sessionFile, directory)
      expect(reopened.getSessionName()).toBe('old name')
      expect(reopened.buildSessionContext().messages).toHaveLength(1)
      await new SessionPersistenceGuard().run(() =>
        renameSession(
          command,
          {
            ...target(),
            currentName: reopened.getSessionName()
          },
          {
            setSessionName: (name) => reopened.appendSessionInfo(name),
            refreshSessions: async () => true
          }
        )
      )
      expect(SessionManager.open(sessionFile, directory).getSessionName()).toBe('new name')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
