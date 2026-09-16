import type { Element, ElementContent } from 'hast'
import { TABLE_BYTE_LIMIT, validateMarkdownTable } from '../../../shared/markdown-table-export'

export function markdownTableCells(node: Element | undefined): string[][] {
  const cells: string[][] = []
  let bytes = 0,
    count = 0
  function text(node: ElementContent): string {
    let value = ''
    if (node.type === 'text') value = node.value
    else if (node.type === 'element' && node.tagName === 'br') value = '\n'
    else if (node.type === 'element' && node.tagName === 'img')
      value = typeof node.properties.alt === 'string' ? node.properties.alt : ''
    else if (node.type === 'element') return node.children.map(text).join('')
    if (value.length > TABLE_BYTE_LIMIT) throw new Error('表格超过上限')
    bytes += new TextEncoder().encode(value).byteLength
    if (bytes > TABLE_BYTE_LIMIT) throw new Error('表格超过上限')
    return value
  }
  for (const section of node?.children ?? []) {
    if (section.type !== 'element' || !['thead', 'tbody', 'tfoot'].includes(section.tagName))
      continue
    for (const row of section.children) {
      if (row.type !== 'element' || row.tagName !== 'tr') continue
      const values: string[] = []
      for (const cell of row.children) {
        if (cell.type !== 'element' || !['th', 'td'].includes(cell.tagName)) continue
        if (++count > 10000 || values.length >= 200) throw new Error('表格超过上限')
        values.push(text(cell))
      }
      cells.push(values)
      if (cells.length > 10000) throw new Error('表格超过上限')
    }
  }
  return validateMarkdownTable({ mode: 'raw', cells }).cells
}
