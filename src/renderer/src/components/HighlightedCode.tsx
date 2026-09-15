import { useEffect, useMemo, useState } from 'react'
import { highlightCode, highlightLanguage, type CodeToken } from '../lib/code-highlight'

export function HighlightedCode({
  text,
  language,
  filename,
  lineNumbers = false,
  streaming = false
}: {
  text: string
  language?: string
  filename?: string
  lineNumbers?: boolean
  streaming?: boolean
}): React.JSX.Element {
  const lang = highlightLanguage(language, filename)
  const [result, setResult] = useState<{ text: string; lang: string; tokens: CodeToken[] } | null>(
    null
  )
  useEffect(() => {
    let active = true
    if (!streaming && lang)
      void highlightCode(text, lang).then((tokens) => {
        if (active) setResult(tokens ? { text, lang, tokens } : null)
      })
    return () => {
      active = false
    }
  }, [text, lang, streaming])
  const tokens = !streaming && result?.text === text && result.lang === lang ? result.tokens : null
  const lines = useMemo(() => {
    // Keep the existing full-text fallback bounded for newline-heavy files.
    if (!lineNumbers || text.split('\n').length > 10_000) return null
    const rows: CodeToken[][] = [[]]
    for (const token of tokens ?? [{ content: text, color: 'inherit' }]) {
      token.content.split('\n').forEach((content, index) => {
        if (index) rows.push([])
        rows[rows.length - 1].push({ ...token, content })
      })
    }
    return rows
  }, [lineNumbers, tokens, text])
  return (
    <code
      className={`highlighted-code${lineNumbers ? ' with-line-numbers' : ''}`}
      data-highlighted={tokens ? 'true' : 'false'}
    >
      {lines
        ? lines.map((line, index) => (
            <span className="source-line" key={index}>
              <span className="source-line-number" aria-hidden="true" data-line={index + 1} />
              <span className="source-line-text">
                {line.map((token, part) => (
                  <span key={part} style={{ color: token.color }}>
                    {token.content}
                  </span>
                ))}
                {index < lines.length - 1 ? '\n' : ''}
              </span>
            </span>
          ))
        : tokens
          ? tokens.map((token, index) => (
              <span key={index} style={{ color: token.color }}>
                {token.content}
              </span>
            ))
          : text}
    </code>
  )
}
