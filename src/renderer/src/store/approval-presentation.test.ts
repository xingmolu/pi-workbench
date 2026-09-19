import { expect, it } from 'vitest'
import type { ApprovalRequest } from '../../../shared/contracts'
import { approvalPreview } from './approval-presentation'
const request = (detail: string): ApprovalRequest => ({
  id: 'pending',
  generation: 1,
  toolCallId: 'call',
  toolName: 'bash',
  intent: 'terminal',
  title: '执行命令',
  detail
})
it('shows the actual command including all lines, without a truncating title', () => {
  const command = 'echo one\nprintf "二"\nrm -f -- temp.txt'
  expect(approvalPreview(request(JSON.stringify({ command })))).toEqual({
    label: '将执行的命令',
    text: command,
    parameters: null
  })
})
it('does not hide extra parameters such as cwd or environment', () => {
  const raw = JSON.stringify({
    command: 'ls',
    cwd: '/other',
    env: { LANG: 'C' },
    futureField: true
  })
  expect(approvalPreview(request(raw))).toEqual({
    label: '将执行的命令',
    text: 'ls',
    parameters: raw
  })
})
it.each(['plain\ntext', 'null', '[]', '{broken', '"test"', '{"command":42}'])(
  'retains unrecognized detail exactly: %s',
  (detail) => expect(approvalPreview(request(detail)).text).toBe(detail)
)
it('preserves file paths and complete proposed content', () => {
  const detail = JSON.stringify({
    path: 'notes.txt',
    content: '<script>not executable markup</script>'
  })
  expect(approvalPreview({ ...request(detail), intent: 'diff', toolName: 'write' })).toEqual({
    label: '将修改的文件与内容',
    text: detail,
    parameters: null
  })
})
