import { useEffect, useState } from 'react'
import { highlightCode, highlightLanguage, type CodeToken } from '../lib/code-highlight'

export function HighlightedCode({
  text,
  language,
  filename,
  streaming = false
}: {
  text: string
  language?: string
  filename?: string
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
  return (
    <code className="highlighted-code" data-highlighted={tokens ? 'true' : 'false'}>
      {tokens
        ? tokens.map((token, index) => (
            <span key={index} style={{ color: token.color }}>
              {token.content}
            </span>
          ))
        : text}
    </code>
  )
}
