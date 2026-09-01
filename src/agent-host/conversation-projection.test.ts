import { describe, expect, it, vi } from 'vitest'
import type { ConversationNode } from '../shared/contracts'
import { ConversationProjection } from './conversation-projection'

describe('ConversationProjection', () => {
  it('compares only current streaming nodes when history is long', () => {
    const equals = vi.fn((left: ConversationNode, right: ConversationNode) => {
      return JSON.stringify(left) === JSON.stringify(right)
    })
    const projection = new ConversationProjection(equals)
    const history: ConversationNode[] = Array.from({ length: 5_000 }, (_, index) => ({
      id: `assistant-${index}`,
      type: 'assistant',
      markdown: `completed ${index}`
    }))
    projection.reset(history)
    const unchangedFirst = projection.view()[0]

    projection.replaceGroup('streaming-message', [
      {
        id: 'assistant-4999',
        type: 'assistant',
        markdown: 'corrected 4999',
        streaming: true
      }
    ])

    expect(equals).toHaveBeenCalledTimes(1)
    expect(projection.view()[0]).toBe(unchangedFirst)
    expect(projection.drainChanges()).toEqual({
      nodeUpserts: [
        {
          id: 'assistant-4999',
          type: 'assistant',
          markdown: 'corrected 4999',
          streaming: true
        }
      ],
      removedNodeIds: []
    })
  })

  it('converges a completed correction through the same stable node id', () => {
    const projection = new ConversationProjection()
    projection.reset([])
    projection.replaceGroup('message-1', [
      { id: 'assistant-1-0', type: 'assistant', markdown: 'draft', streaming: true }
    ])
    projection.drainChanges()

    projection.replaceGroup('message-1', [
      { id: 'assistant-1-0', type: 'assistant', markdown: 'final', streaming: false }
    ])

    expect(projection.drainChanges()).toEqual({
      nodeUpserts: [
        { id: 'assistant-1-0', type: 'assistant', markdown: 'final', streaming: false }
      ],
      removedNodeIds: []
    })
    expect(projection.view()).toEqual([
      { id: 'assistant-1-0', type: 'assistant', markdown: 'final', streaming: false }
    ])
  })

  it('removes corrected streaming blocks tracked by a durable snapshot', () => {
    const projection = new ConversationProjection()
    projection.reset([
      { id: 'assistant-1-0', type: 'assistant', markdown: 'keep', streaming: true },
      { id: 'think-1-1', type: 'think', text: 'remove', streaming: true }
    ])
    projection.trackGroup('message-1', ['assistant-1-0', 'think-1-1'])

    projection.replaceGroup('message-1', [
      { id: 'assistant-1-0', type: 'assistant', markdown: 'final', streaming: false }
    ])

    expect(projection.drainChanges()).toEqual({
      nodeUpserts: [
        { id: 'assistant-1-0', type: 'assistant', markdown: 'final', streaming: false }
      ],
      removedNodeIds: ['think-1-1'],
      nodeOrder: ['assistant-1-0']
    })
  })
})
