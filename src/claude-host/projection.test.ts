import { describe, expect, it } from 'vitest'
import type { SDKMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeProjection } from './projection'

const session = 'ab8e54bd-47d9-47d8-a428-3c43bb11f1ea'
function event(event: unknown): SDKMessage {
  return {
    type: 'stream_event',
    session_id: session,
    uuid: 'uuid',
    parent_tool_use_id: null,
    event
  } as unknown as SDKMessage
}
describe('Claude native conversation projection', () => {
  it('reconciles final native ids without duplicate blocks or reordering tool calls', () => {
    const projection = new ClaudeProjection()
    projection.accept(event({ type: 'message_start', message: { id: 'msg_1' } }))
    projection.accept(
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    )
    projection.accept(
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } })
    )
    projection.accept(
      event({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'thinking', thinking: 'Plan' }
      })
    )
    projection.accept(
      event({
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} }
      })
    )
    projection.accept({
      type: 'assistant',
      uuid: 'native-uuid',
      session_id: session,
      parent_tool_use_id: null,
      message: {
        id: 'msg_1',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'thinking', thinking: 'Plan' },
          { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: 'a' } }
        ]
      }
    } as unknown as SDKMessage)
    expect(projection.nodes.map((node) => node.type)).toEqual(['assistant', 'think', 'tool'])
    expect(projection.nodes.map((node) => node.id)).toEqual([
      'native-uuid:0',
      'native-uuid:1',
      'native-uuid:2'
    ])
    expect(projection.nodes[0].presentationIdentity).toBe('msg_1:0')
    projection.accept({
      type: 'user',
      uuid: 'result',
      session_id: session,
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'Read output', is_error: false }
        ]
      }
    } as unknown as SDKMessage)
    expect(projection.nodes[2]).toMatchObject({ status: 'success', output: 'Read output' })
  })
  it('does not duplicate optimistically admitted image/text user messages on replay', () => {
    const projection = new ClaudeProjection()
    projection.upsert({ id: 'user-uuid', type: 'user', text: 'Hello', imageCount: 1 })
    projection.accept({
      type: 'user',
      uuid: 'user-uuid',
      session_id: session,
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'image', source: {} }
        ]
      }
    } as unknown as SDKMessage)
    expect(projection.nodes).toHaveLength(1)
    expect(projection.nodes[0]).toMatchObject({ id: 'user-uuid', text: 'Hello', imageCount: 1 })
  })
  it('keeps a child streaming when the parent turn finishes', () => {
    const projection = new ClaudeProjection()
    projection.accept({
      ...event({ type: 'message_start', message: { id: 'child_1' } }),
      parent_tool_use_id: 'agent_1'
    } as unknown as SDKMessage)
    projection.accept({
      ...event({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'Part' }
      }),
      parent_tool_use_id: 'agent_1'
    } as unknown as SDKMessage)
    projection.finish()
    expect(projection.children.get('agent_1')?.nodes[0]).toMatchObject({ streaming: true })
    projection.accept({
      ...event({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' two' }
      }),
      parent_tool_use_id: 'agent_1'
    } as unknown as SDKMessage)
    expect(projection.children.get('agent_1')?.nodes[0]).toMatchObject({
      markdown: 'Part two',
      streaming: true
    })
  })

  it('loads canonical SDK history and keeps child streaming out of the parent chain', () => {
    const projection = new ClaudeProjection()
    projection.load([
      {
        type: 'user',
        uuid: 'user-uuid',
        session_id: session,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { content: 'Hello' }
      } satisfies SessionMessage
    ])
    projection.accept({
      ...event({ type: 'message_start', message: { id: 'child_1' } }),
      parent_tool_use_id: 'agent_1'
    } as unknown as SDKMessage)
    projection.accept({
      ...event({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'Child secret' }
      }),
      parent_tool_use_id: 'agent_1'
    } as unknown as SDKMessage)
    expect(projection.nodes).toHaveLength(1)
    expect(projection.children.get('agent_1')?.nodes[0]).toMatchObject({
      type: 'assistant',
      markdown: 'Child secret'
    })
  })
  it('loads native task notifications as child metadata and preserves ordinary user prompts', () => {
    const projection = new ClaudeProjection()
    const saved = (
      type: SessionMessage['type'],
      uuid: string,
      content: unknown
    ): SessionMessage => ({
      type,
      uuid,
      session_id: session,
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: { content }
    })
    projection.load([
      saved('user', 'prompt', 'Explain the <task-notification> tag'),
      saved('assistant', 'agent', [
        {
          type: 'tool_use',
          id: 'agent_1',
          name: 'Agent',
          input: { description: 'Inspect fixture child', prompt: 'child fixture' }
        }
      ]),
      saved(
        'user',
        'notification',
        `<task-notification>
<task-id>native-child</task-id>
<tool-use-id>agent_1</tool-use-id>
<output-file>/private/native/task.output</output-file>
<status>completed</status>
<summary>Agent "Inspect fixture child" finished</summary>
<result>Private child fixture reply.</result>
</task-notification>`
      ),
      saved(
        'user',
        'ordinary',
        '<task-notification>Example XML without SDK task metadata</task-notification>'
      )
    ])
    expect(
      projection.nodes.filter((node) => node.type === 'user').map((node) => node.text)
    ).toEqual([
      'Explain the <task-notification> tag',
      '<task-notification>Example XML without SDK task metadata</task-notification>'
    ])
    expect(projection.tasks.get('native-child')).toMatchObject({
      title: 'Inspect fixture child',
      prompt: 'child fixture',
      state: 'success',
      workerId: 'agent_1'
    })
    expect(projection.nodes[1]).toMatchObject({
      subagent: {
        children: [{ title: 'Inspect fixture child', output: 'Private child fixture reply.' }]
      }
    })
  })
  it('hides synthetic SDK text while retaining synthetic tool results', () => {
    const projection = new ClaudeProjection()
    projection.accept({
      type: 'user',
      uuid: '00000000-0000-0000-0000-000000000001',
      isSynthetic: true,
      session_id: session,
      parent_tool_use_id: null,
      message: { role: 'user', content: 'SDK control text' }
    })
    expect(projection.nodes).toHaveLength(0)
    projection.upsert({
      id: 'tool',
      type: 'tool',
      toolCallId: 'read_1',
      name: 'Read',
      title: 'Read',
      intent: 'read',
      status: 'running'
    })
    projection.accept({
      type: 'user',
      uuid: '00000000-0000-0000-0000-000000000002',
      isSynthetic: true,
      session_id: session,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'read_1', content: 'Native file content' }]
      }
    })
    expect(projection.nodes).toEqual([
      expect.objectContaining({
        status: 'success',
        output: 'Native file content'
      })
    ])
  })
})
