import { describe, expect, it } from 'vitest'
import { mobilePageHtml } from './mobile-web-page'

describe('mobile conversation page', () => {
  it('renders a dense session list instead of fat timestamp cards', () => {
    const html = mobilePageHtml()
    expect(html).toContain('session-row')
    expect(html).toContain('group-label')
    expect(html).toContain('搜索会话')
    expect(html).toContain('仅扫自己的码')
    expect(html).not.toContain('session.modified')
    expect(html).not.toContain('fat')
  })
})
