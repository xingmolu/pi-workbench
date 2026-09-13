import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { HighlightedCode } from './HighlightedCode'
import { highlightCode, highlightLanguage, canHighlight } from '../lib/code-highlight'

it('preserves raw source and safely escapes unknown code', () => {
  const text = '\t<script>alert(1)</script>\r\n\r\n'
  const html = renderToStaticMarkup(createElement(HighlightedCode, { text, language: 'unknown' }))
  expect(html).toContain('\t&lt;script&gt;alert(1)&lt;/script&gt;\r\n\r\n')
  expect(html).not.toContain('<script>')
})
it.each(['constructor', '__proto__', 'toString'])(
  'treats prototype key %s as unknown without starting a worker',
  async (language) => {
    const worker = vi.fn()
    vi.stubGlobal('Worker', worker)
    try {
      expect(highlightLanguage(language)).toBeUndefined()
      expect(highlightLanguage(undefined, `file.${language}`)).toBeUndefined()
      expect(await highlightCode('const x = 1', language)).toBeNull()
      expect(worker).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  }
)
it('keeps cache accounting bounded across concurrent identical requests', async () => {
  class TestWorker {
    onmessage?: (event: { data: { id: number; tokens: { content: string }[] } }) => void
    postMessage({ id, text }: { id: number; text: string }): void {
      queueMicrotask(() => this.onmessage?.({ data: { id, tokens: [{ content: text }] } }))
    }
    terminate(): void {}
  }
  vi.stubGlobal('Worker', TestWorker)
  try {
    const text = 'const value = 42\r\n'.repeat(4000)
    const results = await Promise.all(
      Array.from({ length: 12 }, () => highlightCode(text, 'typescript'))
    )
    expect(results.every((tokens) => tokens?.map((token) => token.content).join('') === text)).toBe(
      true
    )
    for (let i = 0; i < 30; i++)
      expect(await highlightCode(`${i}\n${text}`, 'typescript')).not.toBeNull()
  } finally {
    vi.unstubAllGlobals()
  }
})
it('infers controlled languages and refuses unknown and costly input', () => {
  expect(highlightLanguage(undefined, 'src/main.tsx')).toBe('tsx')
  expect(highlightLanguage('js')).toBe('javascript')
  expect(highlightLanguage('made-up')).toBeUndefined()
  expect(canHighlight('x'.repeat(4001))).toBe(false)
  expect(canHighlight('a\n'.repeat(60000))).toBe(false)
  expect(canHighlight('\tconst x = 1\r\n\r\n')).toBe(true)
})
