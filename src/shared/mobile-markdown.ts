/** Tiny markdown subset for the remote PWA. No HTML passthrough. */
export function renderMobileMarkdown(markdown: string): string {
  const escape = (value: string): string =>
    String(value ?? '').replace(/[&<>"]/g, (ch) => {
      if (ch === '&') return '&amp;'
      if (ch === '<') return '&lt;'
      if (ch === '>') return '&gt;'
      return '&quot;'
    })
  const inline = (value: string): string => {
    let text = escape(value)
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>')
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    text = text.replace(
      /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    )
    return text
  }
  const lines = String(markdown ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.startsWith('```')) {
      const buf: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        buf.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) index += 1
      out.push('<pre><code>' + escape(buf.join('\n')) + '</code></pre>')
      continue
    }
    const heading = /^(#{1,3}) (.+)/.exec(line)
    if (heading) {
      const level = heading[1]!.length
      out.push('<h' + level + '>' + inline(heading[2]!) + '</h' + level + '>')
      index += 1
      continue
    }
    if (/^[-*] /.test(line) || /^\d+\. /.test(line)) {
      const ordered = /^\d+\. /.test(line)
      const items: string[] = []
      while (
        index < lines.length &&
        (ordered ? /^\d+\. /.test(lines[index] ?? '') : /^[-*] /.test(lines[index] ?? ''))
      ) {
        items.push(
          '<li>' +
            inline((lines[index] ?? '').replace(/^([-*] |\d+\. )/, '')) +
            '</li>'
        )
        index += 1
      }
      out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'))
      continue
    }
    if (!line.trim()) {
      index += 1
      continue
    }
    const para = [line]
    index += 1
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() &&
      !/^(#{1,3}) /.test(lines[index] ?? '') &&
      !/^[-*] /.test(lines[index] ?? '') &&
      !/^\d+\. /.test(lines[index] ?? '') &&
      !(lines[index] ?? '').startsWith('```')
    ) {
      para.push(lines[index] ?? '')
      index += 1
    }
    out.push('<p>' + inline(para.join('\n')).replace(/\n/g, '<br/>') + '</p>')
  }
  return out.join('')
}
