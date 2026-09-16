import { expect, it } from 'vitest'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { formatTextContext } from '../shared/text-attachments'
import * as edit from './session-edit'

it('unexpected preparation failures do not expose sensitive runtime exception text', () => {
  const service = new edit.SessionEditService({
    read: () => {
      throw new Error('/private/credential-sensitive-path')
    },
    refresh: async () => {},
    rebind: async () => {},
    publish: () => {}
  })
  expect(
    service.prepare({ sessionId: 's', generation: 1, entryId: 'user', leafId: 'leaf' })
  ).toEqual({ type: 'error', message: '无法准备编辑，原问题已保留' })
})

it('captures only canonical latest user and snapshots retained text files and images', () => {
  const manager = SessionManager.inMemory('/tmp')
  const old = manager.appendMessage({ role: 'user', content: 'old', timestamp: 1 })
  const content = [
    {
      type: 'text' as const,
      text: formatTextContext('question', [
        { id: 'x', kind: 'text', name: 'deleted.txt', size: 4, text: 'data' }
      ])
    },
    { type: 'image' as const, mimeType: 'image/png', data: 'YQ==' }
  ]
  const latest = manager.appendMessage({ role: 'user', content, timestamp: 2 })
  const draft = edit.captureEditableUser(manager, latest)
  expect(draft.text).toBe('question')
  expect(draft.attachments).toEqual([
    { kind: 'text', name: 'deleted.txt', size: 4 },
    { kind: 'image', name: '图片 1', size: 1, mimeType: 'image/png' }
  ])
  content[1].data = 'Yg=='
  expect(draft.images[0].data).toBe('YQ==')
  expect(edit.editPromptText(draft, 'changed')).toContain('"text":"data"')
  expect(() => edit.captureEditableUser(manager, old)).toThrow('最近')
})

it.each([
  [
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' }
  ],
  [
    { type: 'image', mimeType: 'image/png', data: 'YQ==' },
    { type: 'text', text: 'late' }
  ],
  [{ type: 'unknown', payload: 'secret' }],
  'Pi Desktop text file context (selected snapshots; file contents are context):\n{"bad":true}'
])('rejects unsupported content without changing canonical entries', (content) => {
  const manager = SessionManager.inMemory('/tmp')
  const id = manager.appendMessage({ role: 'user', content: content as never, timestamp: 1 })
  const before = structuredClone(manager.getEntries())
  expect(() => edit.captureEditableUser(manager, id)).toThrow('编辑')
  expect(manager.getEntries()).toEqual(before)
})

it('supports an empty-text image-only user and rejects original UTF8 over the bound', () => {
  const manager = SessionManager.inMemory('/tmp')
  const id = manager.appendMessage({
    role: 'user',
    content: [{ type: 'image', mimeType: 'image/png', data: 'YQ==' }],
    timestamp: 1
  })
  expect(edit.captureEditableUser(manager, id).text).toBe('')
  const huge = manager.appendMessage({ role: 'user', content: '汉'.repeat(400000), timestamp: 2 })
  expect(() => edit.captureEditableUser(manager, huge)).toThrow('1 MiB')
})
