import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import ApprovalCard from './ApprovalCard'
import type { ApprovalRequest } from '../../../shared/contracts'
const request: ApprovalRequest = {
  id: 'a',
  generation: 1,
  toolCallId: 'call',
  toolName: 'bash',
  intent: 'terminal',
  title: 'Run',
  detail: JSON.stringify({ command: 'echo <test>\nprintf second' })
}
it('shows scope, exact operation preview and both decisions without an extra expansion', () => {
  const html = renderToStaticMarkup(
    <ApprovalCard request={request} projectPath="/test" onApproval={async () => true} />
  )
  expect(html).toContain('仅本次操作')
  expect(html).toContain('data-approval-actions="a"')
  expect(html).toContain('echo &lt;test&gt;\nprintf second')
  expect(html).toContain('允许一次')
  expect(html).toContain('拒绝')
  expect(html).not.toContain('autofocus')
  expect(html).not.toContain('<details')
  expect(html).not.toContain('始终允许')
})
it('keeps complete parameters available without expanding the card by default', () => {
  const html = renderToStaticMarkup(
    <ApprovalCard
      request={{ ...request, detail: '{"command":"ls","cwd":"/outside"}' }}
      onApproval={async () => true}
    />
  )
  expect(html).toContain('<details class="approval-parameters">')
  expect(html).not.toContain('<details class="approval-parameters" open=""')
  expect(html).toContain('/outside')
})
it('offers allowing the whole task for the app a Computer Use action targets', () => {
  const computer: ApprovalRequest = {
    ...request,
    toolName: 'computer',
    intent: 'desktop',
    detail: JSON.stringify({ action: 'act', stateId: 's', intent: 'key', key: 'Enter' }),
    grant: { kind: 'computer-app', app: 'HoYowave', bundleId: 'com.miHoYo.HoYowave' }
  }
  const html = renderToStaticMarkup(
    <ApprovalCard request={computer} onApproval={async () => true} />
  )
  expect(html).toContain('本轮允许操作 HoYowave')
  // Saving a rule needs a project to keep it in.
  expect(html).not.toContain('总是允许操作')
  expect(
    renderToStaticMarkup(
      <ApprovalCard request={computer} projectPath="/test" onApproval={async () => true} />
    )
  ).toContain('总是允许操作 HoYowave')
  expect(
    renderToStaticMarkup(<ApprovalCard request={request} onApproval={async () => true} />)
  ).not.toContain('本轮允许')
})
