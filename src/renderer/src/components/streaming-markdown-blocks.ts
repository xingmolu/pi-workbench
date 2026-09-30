/**
 * Freeze completed top-level paragraphs, tables and fences while the tail grows.
 * Lists, quotes, references and raw HTML can cross blank lines: leave those documents
 * whole rather than changing their meaning. Completion always uses the full document.
 */
export function streamingMarkdownBlocks(source: string): string[] {
  const blocks: string[] = []
  let start = 0
  let offset = 0
  let fence: { char: string; length: number } | null = null
  for (const line of source.split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line)
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length }
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim())
        fence = null
    } else if (!fence && (
      /^(?: {0,3}(?:[-+*] |\d+[.)] |>\s?|<|\[[^\]]+\]:)| {4}\S|\t\S)/.test(line) ||
      /\]\s*\[/.test(line)
    )) {
      // Code contents cannot change the surrounding document's block structure.
      return [source]
    }
    offset += line.length
    if (!fence && /^\s*\n$/.test(line) && offset < source.length) {
      blocks.push(source.slice(start, offset))
      start = offset
    }
  }
  if (start < source.length) blocks.push(source.slice(start))
  return blocks.length ? blocks : [source]
}
