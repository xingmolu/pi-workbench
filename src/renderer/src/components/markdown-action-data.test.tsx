import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { expect, it } from 'vitest'
import { markdownTableCells } from './markdown-action-data'
it('extracts actual displayed rectangle, links, code and alt, excluding excess GFM source cells', () => {
  let cells: string[][] = []
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      children:
        '| A | B |\n|---|---|\n| [label](https://example.com) **bold** | ![alt](https://example.com/x) `00123` | excluded |',
      remarkPlugins: [remarkGfm],
      components: {
        table: ({ node }) => {
          cells = markdownTableCells(node)
          return null
        }
      }
    })
  )
  expect(cells).toEqual([
    ['A', 'B'],
    ['label bold', 'alt 00123']
  ])
})
