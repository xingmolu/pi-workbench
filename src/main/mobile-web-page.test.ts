import { describe, expect, it } from 'vitest'
import { mobileClientScript, mobilePageCss, mobilePageHtml } from './mobile-web-page'

describe('mobile conversation page', () => {
  it('serves a responsive shell with list + chat panes and no desktop workbench chrome', () => {
    const html = mobilePageHtml()
    const css = mobilePageCss()
    const js = mobileClientScript()
    expect(html).toContain('/mobile.css')
    expect(html).toContain('/mobile.js')
    expect(html).toContain('pi-mobile-theme')
    expect(css).toContain('.pane-list')
    expect(css).toContain('.pane-chat')
    expect(css).toContain('@media (min-width: 900px)')
    expect(css).toContain('[data-theme="light"]')
    expect(js).toContain('session-row')
    expect(js).toContain('project-head')
    expect(js).toContain('已连接到')
    expect(js).toContain('已完成')
    expect(js).toContain('renderMarkdown')
    expect(js).toContain('pi-mobile-theme')
    expect(js).toContain('metaKey')
    expect(js).toContain('仅扫自己的码')
    expect(js).not.toContain('插件市场')
    expect(js).not.toContain('Files')
    expect(js + css).not.toContain('session.modified')
  })

  it('emits syntactically valid browser JavaScript', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { execFileSync } = await import('node:child_process')
    const dir = mkdtempSync(join(tmpdir(), 'pi-mobile-js-'))
    const file = join(dir, 'mobile.js')
    writeFileSync(file, mobileClientScript())
    execFileSync(process.execPath, ['--check', file])
  })
})
