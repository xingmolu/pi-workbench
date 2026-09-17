import { expect, it } from 'vitest'
import { textFromContent, toolIntent, toolPresentation } from './message-presentation'

it('extracts only text from supported and legacy content', () => {
  expect(textFromContent('plain')).toBe('plain')
  expect(
    textFromContent([
      { type: 'text', text: 'one' },
      null,
      { type: 'image', data: 'ignored' },
      { type: 'text', text: 'two' }
    ])
  ).toBe('one\ntwo')
  expect(textFromContent(null)).toBe('')
  expect(textFromContent(undefined)).toBe('')
})

it.each([
  ['bash', { command: 'pwd\nls' }, 'terminal', 'pwd'],
  ['powershell', {}, 'terminal', '运行命令'],
  ['read', { path: 'a.ts' }, 'read', '读取 a.ts'],
  ['ls', {}, 'read', '列出 目录'],
  ['write', { filePath: 'a.ts' }, 'diff', '写入 a.ts'],
  ['edit', {}, 'diff', '编辑 文件'],
  ['grep', { pattern: 'foo' }, 'search', '搜索 foo'],
  ['find', { query: 'bar' }, 'search', '搜索 bar'],
  ['browser', { action: 'open' }, 'web', '浏览器 · open'],
  ['custom-browser', {}, 'web', 'custom-browser'],
  ['web', {}, 'web', 'web'],
  ['desktop', { action: 'click', x: 1, y: 2 }, 'desktop', '桌面 · click'],
  ['desktop-control', {}, 'desktop', 'desktop-control'],
  ['custom', {}, 'generic', 'custom']
])('shares %s presentation between approval and transcript', (name, args, intent, title) => {
  expect(toolIntent(String(name))).toBe(intent)
  expect(toolPresentation(String(name), args)).toEqual({
    title,
    detail: JSON.stringify(args, null, 2)
  })
})
