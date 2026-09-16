import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import GitPatchView from './GitPatchView'
import type { GitReviewResult } from '../../../shared/git-review'
type Patch = Extract<GitReviewResult, { type: 'patch' }>
const render = (overrides: Partial<Patch>): string =>
  renderToStaticMarkup(
    createElement(GitPatchView, {
      patch: { type: 'patch', reviewId: 'r', entryId: 'e', kind: 'text', message: '', ...overrides }
    })
  )
it.each(['binary', 'conflict', 'submodule', 'type-only', 'empty', 'untracked'] as const)(
  'preserves complete %s fallback',
  (kind) => {
    const html = render({ kind, text: '<script>RAW END</script>\r\n' })
    expect(html).toContain('&lt;script&gt;RAW END&lt;/script&gt;\r\n')
    expect(html).not.toContain('diffs-container')
  }
)
it('contains malformed, empty, large, and byte-escaped patches', () => {
  expect(render({ text: 'diff --git a/a b/a\n@@ broken\n<script>END</script>' })).toContain(
    '无法解析'
  )
  expect(render({ text: '' })).toContain('未收到文本差异')
  expect(render({ text: 'x\n'.repeat(2001) + 'END' })).toContain('差异较大')
  expect(render({ text: 'x'.repeat(200001) })).toContain('差异较大')
  expect(render({ rawOnly: true, text: '\\xff END' })).toContain('\\xff END')
})
