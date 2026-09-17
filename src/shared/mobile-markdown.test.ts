import { describe, expect, it } from 'vitest'
import { renderMobileMarkdown } from './mobile-markdown'

describe('mobile markdown', () => {
  it('renders headings, lists, emphasis, code, and https links', () => {
    const html = renderMobileMarkdown(
      [
        '## 给你一个以后快速判断的路径',
        '',
        '看到 `hash` 不用慌，问三个问题：',
        '',
        '1. 比较的两侧是谁？',
        '2. **失败态**怎样？',
        '',
        '- 安全',
        '- 危险',
        '',
        '这是这次 [改造](https://example.com/doc) 的教训。',
        '',
        '```',
        '<script>alert(1)</script>',
        '```'
      ].join('\n')
    )
    expect(html).toContain('<h2>')
    expect(html).toContain('<ol>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<strong>失败态</strong>')
    expect(html).toContain('<code>hash</code>')
    expect(html).toContain('href="https://example.com/doc"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert')
  })

  it('does not treat javascript URLs as links', () => {
    const html = renderMobileMarkdown('[x](javascript:alert(1))')
    expect(html).not.toContain('href="javascript')
    expect(html).toContain('[x](javascript:alert(1))')
  })
})
