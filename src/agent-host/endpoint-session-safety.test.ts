import { describe, expect, it } from 'vitest'
import { assertEndpointContext, EndpointSessionSafety } from './endpoint-session-safety'

describe('endpoint session safety latches', () => {
  const target = { sessionId: 'session-a', generation: 1, projectPath: '/fixture/project' }
  it('runtime recovery cannot clear invalidation; explicit selection cannot clear runtime failure', () => {
    const safety = new EndpointSessionSafety()
    safety.bind(target)
    safety.invalidate(target)
    safety.setRuntimeBlocked(target, true)
    safety.setRuntimeBlocked(target, false)
    expect(safety.reason(target)).toBe('endpoint-selection-invalidated')
    safety.setRuntimeBlocked(target, true)
    safety.selected(target)
    expect(safety.reason(target)).toBe('endpoint-runtime-unsynchronized')
    safety.setRuntimeBlocked(target, false)
    expect(safety.reason(target)).toBeNull()
  })
  it('ignores old generation callbacks and clears both latches only at a new bind', () => {
    const safety = new EndpointSessionSafety()
    safety.bind(target)
    safety.invalidate(target)
    safety.setRuntimeBlocked(target, true)
    const next = { ...target, generation: 2 }
    safety.bind(next)
    safety.invalidate(target)
    safety.setRuntimeBlocked(target, true)
    expect(safety.reason(next)).toBeNull()
  })
  it('captures identity rather than retaining a mutable caller object', () => {
    const safety = new EndpointSessionSafety()
    const mutable = { ...target }
    safety.bind(mutable)
    safety.invalidate(mutable)
    mutable.generation++
    expect(safety.reason(mutable)).toBeNull()
    expect(safety.reason(target)).toBe('endpoint-selection-invalidated')
  })
  it('rejects context captured before a queued session or project replacement', () => {
    expect(() =>
      assertEndpointContext(target, { ...target, projectPath: '/fixture/other' })
    ).toThrow('已切换')
    expect(() => assertEndpointContext(target, { ...target, generation: 2 })).toThrow('已切换')
    expect(() => assertEndpointContext(target, { ...target, sessionId: 'session-b' })).toThrow(
      '已切换'
    )
    expect(() => assertEndpointContext(target, target)).not.toThrow()
  })
})
