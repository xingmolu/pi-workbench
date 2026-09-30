import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import SubagentTool from './SubagentTool'
import type { ConversationNode } from '../../../shared/contracts'
const node: Extract<ConversationNode, { type: 'tool' }> = {
  id: 'delegate',
  type: 'tool',
  name: 'session_task',
  toolCallId: 'call',
  intent: 'generic',
  title: 'delegate',
  status: 'success',
  output: 'RAW_JSON',
  subagent: {
    operation: 'spawn',
    children: [
      { id: 'running', title: 'Review', state: 'running', activity: 'Read auth.ts' },
      { id: 'failed', title: 'Tests', state: 'error', output: 'Provider unavailable' }
    ]
  }
}
it('shows ongoing child activity despite finished dispatch and opens failure details without exposing raw JSON', () => {
  const html = renderToStaticMarkup(<SubagentTool node={node} childrenById={new Map()} />)
  expect(html.match(/class="subagent-summary /g)).toHaveLength(2)
  expect(html).toContain('subagent-kind is-active')
  expect(html).toContain('Read auth.ts')
  expect(html).toContain('Provider unavailable')
  expect(html).not.toContain('RAW_JSON')
  expect(html).toContain('查看子 Agent：Review')
  expect(html).toContain('查看子 Agent：Tests')
  expect(html).not.toContain('停止子 Agent：Review')
})
