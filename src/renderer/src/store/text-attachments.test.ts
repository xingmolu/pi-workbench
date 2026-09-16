import { expect, it, vi } from 'vitest'
import { sendTextFiles, useTextAttachments } from './text-attachments'

it('keeps known local pre-dispatch validation failures editable without issuing IPC', async () => {
  const invoke = vi.fn()
  vi.stubGlobal('window', { pi: { textAttachments: invoke } })
  const files = [
    {
      id: '90000000-0000-4000-8000-000000000001',
      name: 'fixture.txt',
      kind: 'text' as const,
      size: 0
    }
  ]
  useTextAttachments.setState({
    scope: { projectPath: '/fixture', sessionId: 'fixture', generation: 1 },
    files,
    staging: false,
    sending: false,
    submission: null
  })
  try {
    expect(await sendTextFiles('x'.repeat(1048577))).toMatchObject({ status: 'rejected' })
    expect(invoke).not.toHaveBeenCalled()
    expect(useTextAttachments.getState()).toMatchObject({ files, sending: false, submission: null })
  } finally {
    vi.unstubAllGlobals()
    useTextAttachments.setState({
      scope: null,
      files: [],
      staging: false,
      sending: false,
      submission: null
    })
  }
})
