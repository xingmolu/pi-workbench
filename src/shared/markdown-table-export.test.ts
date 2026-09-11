import { describe, expect, it } from 'vitest'
import {
  serializeMarkdownTable,
  validateMarkdownTable,
  TABLE_BYTE_LIMIT
} from './markdown-table-export'
describe('table export contract', () => {
  it('protects every displayed value and header, preserving Unicode and controls', () => {
    expect(
      serializeMarkdownTable(
        {
          mode: 'text-protected',
          cells: [
            ['标题', '=1+1', '00123'],
            ['＋公式', '\u0001x', '"你好"']
          ]
        },
        true
      )
    ).toEqual({ format: 'TSV', text: "'标题\t'=1+1\t'00123\r\n'＋公式\t'\u0001x\t'\"你好\"" })
    expect(
      serializeMarkdownTable({ mode: 'text-protected', cells: [['a\nb', 'x"y']] }, true)
    ).toEqual({ format: 'CSV', text: '"\'a\nb","\'x""y"' })
    expect(serializeMarkdownTable({ mode: 'raw', cells: [['=1', '00123']] })).toEqual({
      format: 'CSV',
      text: '\uFEFF"=1","00123"'
    })
  })
  it.each([
    null,
    {},
    { mode: 'raw', cells: [] },
    { mode: 'raw', cells: [['a'], []] },
    { mode: 'raw', cells: [[1]] },
    { mode: 'raw', cells: [['a']], path: '/tmp/a' },
    { mode: 'raw', cells: [Array(201).fill('')] },
    { mode: 'raw', cells: Array.from({ length: 51 }, () => Array(200).fill('')) }
  ])('rejects invalid requests %j', (value) => expect(() => validateMarkdownTable(value)).toThrow())
  it('accepts exact output budget and rejects one extra byte without truncation', () => {
    const value = { mode: 'raw', cells: [['x'.repeat(TABLE_BYTE_LIMIT - 5)]] }
    expect(new TextEncoder().encode(serializeMarkdownTable(value).text).length).toBe(
      TABLE_BYTE_LIMIT
    )
    expect(() => serializeMarkdownTable({ ...value, cells: [[value.cells[0][0] + 'x']] })).toThrow()
  })
  it('snapshots caller data', () => {
    const source = { mode: 'raw', cells: [['before']] }
    const result = validateMarkdownTable(source)
    source.cells[0][0] = 'after'
    expect(result.cells).toEqual([['before']])
  })
})
