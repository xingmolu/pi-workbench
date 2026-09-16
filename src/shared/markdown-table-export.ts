export const MARKDOWN_TABLE_EXPORT_CHANNEL = 'pi:export-markdown-table'
export const TABLE_BYTE_LIMIT = 1024 * 1024
export type MarkdownTableRequest = { mode: 'text-protected' | 'raw'; cells: string[][] }
export type MarkdownTableResult =
  { status: 'saved' } | { status: 'cancelled' } | { status: 'failed'; message: string }
const encoder = new TextEncoder()

export function validateMarkdownTable(value: unknown): MarkdownTableRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效表格')
  const data = value as Record<string, unknown>
  if (
    Object.keys(data).length !== 2 ||
    !['text-protected', 'raw'].includes(data.mode as string) ||
    !Array.isArray(data.cells) ||
    !data.cells.length ||
    data.cells.length > 10000
  )
    throw new Error('无效表格')
  let bytes = 0
  let output = 3
  let width = 0
  const cells: string[][] = []
  for (const row of data.cells) {
    if (!Array.isArray(row) || !row.length || row.length > 200 || (width && row.length !== width))
      throw new Error('无效表格')
    width = row.length
    if (width * data.cells.length > 10000) throw new Error('表格超过上限')
    const copy: string[] = []
    for (const cell of row) {
      if (typeof cell !== 'string' || cell.length > TABLE_BYTE_LIMIT) throw new Error('无效表格')
      const size = encoder.encode(cell).byteLength
      bytes += size
      let quotes = 0
      for (let i = 0; i < cell.length; i++) if (cell[i] === '"') quotes++
      output += size + quotes + 2 + (copy.length ? 1 : 0) + (data.mode === 'text-protected' ? 1 : 0)
      if (bytes > TABLE_BYTE_LIMIT || output > TABLE_BYTE_LIMIT) throw new Error('表格超过上限')
      copy.push(cell)
    }
    if (cells.length) output += 2
    if (output > TABLE_BYTE_LIMIT) throw new Error('表格超过上限')
    cells.push(copy)
  }
  return { mode: data.mode as MarkdownTableRequest['mode'], cells }
}

export function serializeMarkdownTable(
  value: unknown,
  clipboard = false
): { text: string; format: 'TSV' | 'CSV' } {
  const { cells, mode } = validateMarkdownTable(value)
  const protectedCell = (cell: string): string => (mode === 'text-protected' ? "'" : '') + cell
  if (
    clipboard &&
    mode === 'text-protected' &&
    cells.every((row) => row.every((cell) => !/[\t\r\n]/.test(cell)))
  ) {
    return {
      text: cells.map((row) => row.map(protectedCell).join('\t')).join('\r\n'),
      format: 'TSV'
    }
  }
  return {
    text:
      (clipboard ? '' : '\uFEFF') +
      cells
        .map((row) =>
          row.map((cell) => '"' + protectedCell(cell).replace(/"/g, '""') + '"').join(',')
        )
        .join('\r\n'),
    format: 'CSV'
  }
}
