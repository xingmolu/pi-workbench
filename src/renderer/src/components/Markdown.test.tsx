import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { codeBlockText, Markdown } from './Markdown'

it('renders table actions through the real Markdown pipeline', () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, { children: '| 名称 | 数量 |\n|---|---|\n| 苹果 | 00123 |' })
  )
  expect(html).toContain('复制表格')
  expect(html).toContain('保存 CSV')
  expect(html).toContain('预览表格')
})

describe('actual ReactMarkdown code payload', () => {
  it.each([
    ['```ts\n\tvalue  \n\n\n```', '\tvalue  \n\n'],
    ['```ts\r\n\tvalue  \r\n\r\n\r\n```', '\tvalue  \r\n\r\n'],
    ['```\n```', ''],
    ['```\n\n\n```', '\n'],
    ['```ts\n  partial\t', '  partial\t'],
    ['    a  \n    b', 'a  \nb']
  ])('removes exactly the pipeline LF from %j', (source, expected) => {
    const values: string[] = []
    renderToStaticMarkup(
      createElement(ReactMarkdown, {
        children: source,
        remarkPlugins: [remarkGfm],
        components: {
          pre: ({ node }) => {
            values.push(codeBlockText(node))
            return null
          }
        }
      })
    )
    expect(values).toEqual([expected])
  })
})
