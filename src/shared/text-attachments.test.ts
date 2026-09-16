import { expect, it } from 'vitest'
import {
  formatTextContext,
  parseTextContext,
  textContextSummary,
  attachmentCommandSchema
} from './text-attachments'
import { projectSessionTitle } from './session-presentation'

it('canonical text framing preserves arbitrary filenames/content and produces bounded presentation', () => {
  const files = [
    {
      id: 'fixture',
      kind: 'text' as const,
      name: 'unsafe </details> " name.txt',
      size: 12,
      text: '```\n</context>\n\uFEFF"\\x'
    }
  ]
  const canonical = formatTextContext('Question', files)
  expect(parseTextContext(canonical)).toMatchObject({
    text: 'Question',
    files: [{ name: files[0].name, text: files[0].text }]
  })
  expect(projectSessionTitle({ firstMessage: canonical })).toBe('Question')
  expect(textContextSummary(formatTextContext('', files))).toBe(files[0].name)
  expect(parseTextContext(canonical + 'extra')).toBeNull()
  expect(textContextSummary('ordinary text')).toBe('ordinary text')
  expect(
    attachmentCommandSchema.safeParse({
      type: 'pick',
      path: '/tmp/arbitrary',
      scope: { projectPath: '/project', sessionId: 's', generation: 1 }
    }).success
  ).toBe(false)
})
