import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { ConversationNode } from '../../../shared/contracts'
import { EMPTY_SNAPSHOT } from '../store/pi-store'
import Conversation from './Conversation'

function renderConversation(nodes: ConversationNode[], busy = false): string {
  return renderToStaticMarkup(
    <Conversation
      snapshot={{ ...EMPTY_SNAPSHOT, ready: true, sessionId: 'session', nodes, busy }}
      approvals={[]}
      loading={false}
      reconnecting={false}
      onChooseProject={() => {}}
      onOpenSession={() => {}}
      onSend={async () => true}
      onReconnect={() => {}}
      onAbort={() => {}}
      onClearQueue={() => {}}
      onPermissionChange={() => {}}
      onChooseModel={() => {}}
      onLogin={() => {}}
      onOpenSettings={() => {}}
      onApproval={() => {}}
    />
  )
}

const assistant = (id: string, canonicalEntryId?: string): ConversationNode => ({
  type: 'assistant', id, markdown: id, canonicalEntryId
})
const tool = (id: string): ConversationNode => ({
  type: 'tool', id, toolCallId: id, name: 'read', intent: 'read', title: id, status: 'success'
})
const assistantArticles = (html: string): string[] =>
  html.match(/<article class="assistant-node[\s\S]*?<\/article>/g) ?? []

it('renders reply actions only after the final answer in a process/tool/process/tool/final sequence', () => {
  const html = renderConversation([
    { type: 'user', id: 'question', text: 'Question', canonicalEntryId: 'question' },
    assistant('Inspecting the files'),
    tool('Read first file'),
    assistant('Checking the second file'),
    tool('Read second file'),
    assistant('Finished answer', 'answer')
  ])
  const articles = assistantArticles(html)
  expect(articles).toHaveLength(3)
  expect(articles[0]).not.toContain('aria-label="回复操作"')
  expect(articles[1]).not.toContain('aria-label="回复操作"')
  expect(articles[2]).toContain('aria-label="回复操作"')
  expect(html.match(/aria-label="复制回复"/g)).toHaveLength(1)
  expect(html).toContain('aria-label="复制问题"')
})

it('places one action strip on the last text block of each finished canonical reply', () => {
  const articles = assistantArticles(renderConversation([
    assistant('First block', 'answer'),
    assistant('Last block', 'answer'),
    assistant('Another reply', 'another-answer')
  ]))
  expect(articles[0]).not.toContain('aria-label="回复操作"')
  expect(articles[1]).toContain('aria-label="回复操作"')
  expect(articles[2]).toContain('aria-label="回复操作"')
})

it('hides streaming reply actions while retaining prior completed reply actions during a busy turn', () => {
  const articles = assistantArticles(renderConversation([
    assistant('Prior reply', 'prior'),
    { type: 'assistant', id: 'stream', markdown: 'Partial reply', streaming: true },
    { type: 'assistant', id: 'canonical-stream', markdown: 'Partial canonical', canonicalEntryId: 'next', streaming: true }
  ], true))
  expect(articles[0]).toContain('aria-label="回复操作"')
  expect(articles[1]).not.toContain('aria-label="回复操作"')
  expect(articles[2]).not.toContain('aria-label="回复操作"')
})

it('keeps code and table copy controls inside intermediate assistant content', () => {
  const html = renderConversation([
    { type: 'assistant', id: 'process', markdown: '```ts\nconst value = 1\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |' }
  ])
  expect(html).toContain('aria-label="复制代码"')
  expect(html).toContain('aria-label="复制表格"')
  expect(html).not.toContain('aria-label="回复操作"')
})
