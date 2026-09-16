import { describe, expect, it } from 'vitest'
import { ToolExecutionState } from './tool-execution-state'

describe('ToolExecutionState', () => {
  it('does not count project resource waiting as execution time', () => {
    const tools = new ToolExecutionState()
    tools.start('waiting', true, 1000)
    expect(tools.waitingForResource('waiting')).toEqual({ status: 'waiting-resource' })
    expect(tools.executionStarted('waiting', 9000)).toEqual({ status: 'running' })
    expect(tools.end('waiting', false, 9020)).toEqual({ status: 'success', durationMs: 20 })
  })
  it('starts approved execution timing after approval, not preflight', () => {
    const tools = new ToolExecutionState()

    expect(tools.start('call-1', true, 1_000)).toEqual({ status: 'queued' })
    expect(tools.approvalPending('call-1')).toEqual({ status: 'awaiting-approval' })
    expect(tools.approvalAllowed('call-1', 6_000)).toEqual({ status: 'running' })
    expect(tools.end('call-1', false, 6_125)).toEqual({
      status: 'success',
      durationMs: 125
    })
  })

  it('keeps blocked terminal when Pi later emits an error end', () => {
    const tools = new ToolExecutionState()

    tools.start('call-2', true, 1_000)
    tools.approvalPending('call-2')
    expect(tools.approvalBlocked('call-2')).toEqual({ status: 'blocked' })
    expect(tools.end('call-2', true, 9_000)).toEqual({ status: 'blocked' })
  })

  it('starts open and non-sensitive tools immediately', () => {
    const tools = new ToolExecutionState()

    expect(tools.start('call-3', false, 2_000)).toEqual({ status: 'running' })
    expect(tools.end('call-3', false, 2_040)).toEqual({
      status: 'success',
      durationMs: 40
    })
  })
})
