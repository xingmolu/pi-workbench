import { describe, expect, it } from 'vitest'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import {
  readAgentSessionIdentity,
  subscribeAgentSessionIdentity
} from './agent-session-identity'
import { ConversationProjection } from './conversation-projection'
import { SessionHistoryController } from './session-history-controller'

function manager(sessionId: string): SessionManager {
  return {
    getSessionId: () => sessionId,
    getBranch: () => []
  } as unknown as SessionManager
}

describe('SessionTask parent identity lifecycle', () => {
  it('does not publish a transient null identity during an ordinary history rebind', () => {
    const events: Array<{ sessionId: string | null; generation: number } | null> = []
    const unsubscribe = subscribeAgentSessionIdentity((identity) => events.push(identity))
    const history = new SessionHistoryController(new ConversationProjection())
    const value = manager('parent-session')

    try {
      history.bind(value, 3)
      expect(readAgentSessionIdentity()).toEqual({ sessionId: 'parent-session', generation: 3 })

      history.bind(value, 3)
      expect(readAgentSessionIdentity()).toEqual({ sessionId: 'parent-session', generation: 3 })
      expect(events).toEqual([{ sessionId: 'parent-session', generation: 3 }])

      history.detach()
      expect(readAgentSessionIdentity()).toEqual({ sessionId: null, generation: 0 })
      expect(events).toEqual([{ sessionId: 'parent-session', generation: 3 }, null])
    } finally {
      history.detach()
      unsubscribe()
    }
  })
})
