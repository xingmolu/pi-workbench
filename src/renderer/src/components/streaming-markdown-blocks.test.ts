import { expect, it } from 'vitest'
import { streamingMarkdownBlocks } from './streaming-markdown-blocks'
it('keeps a completed table stable while only the tail grows', () => {
  const table = '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n'
  expect(streamingMarkdownBlocks(table + 'hello')).toEqual([table, 'hello'])
  expect(streamingMarkdownBlocks(table + 'hello world')).toEqual([table, 'hello world'])
})
it('does not split blank lines inside open or closed code fences', () => {
  const code = '```ts\nlet x = 1\n\nlet y = 2\n```\n\n'
  expect(streamingMarkdownBlocks(code + 'tail')).toEqual([code, 'tail'])
  expect(streamingMarkdownBlocks(code.slice(0, -5))).toHaveLength(1)
})
it('keeps the fence in the same block when streamed code indentation or Markdown-like contents change', () => {
  const paragraph = 'Before the code.\n\n'
  for (const content of ['\tconst value = 1', '    const value = 1', '- item', '[link][ref]', '<div>', 'changed']) {
    const fence = `\`\`\`ts\n${content}\n\n\`\`\``
    expect(streamingMarkdownBlocks(paragraph + fence)).toEqual([paragraph, fence])
  }
})
it.each([
  '- first\n\n- second',
  '> quote\n\n> continuation',
  '[link][ref]\n\n[ref]: https://example.com',
  'text\n\n    code',
  '<div>\n\ntext\n</div>'
])('preserves cross-block Markdown semantics: %s', (source) => {
  expect(streamingMarkdownBlocks(source)).toEqual([source])
})
