import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import theme from 'shiki/themes/github-dark.mjs'
import typescript from 'shiki/langs/typescript.mjs'
import tsx from 'shiki/langs/tsx.mjs'
import javascript from 'shiki/langs/javascript.mjs'
import jsx from 'shiki/langs/jsx.mjs'
import json from 'shiki/langs/json.mjs'
import jsonc from 'shiki/langs/jsonc.mjs'
import shellscript from 'shiki/langs/shellscript.mjs'
import python from 'shiki/langs/python.mjs'
import css from 'shiki/langs/css.mjs'
import html from 'shiki/langs/html.mjs'
import markdown from 'shiki/langs/markdown.mjs'
import yaml from 'shiki/langs/yaml.mjs'
import type { CodeToken } from './code-highlight'

const highlighter = createHighlighterCore({
  themes: [theme],
  langs: [
    typescript,
    tsx,
    javascript,
    jsx,
    json,
    jsonc,
    shellscript,
    python,
    css,
    html,
    markdown,
    yaml
  ],
  engine: createJavaScriptRegexEngine()
})
self.onmessage = async (event: MessageEvent<{ id: number; text: string; language: string }>) => {
  const { id, text, language } = event.data
  try {
    const lines = (await highlighter).codeToTokens(text, {
      lang: language,
      theme: 'github-dark'
    }).tokens
    const endings = text.match(/\r\n|\r|\n/g) ?? []
    const tokens: CodeToken[] = []
    lines.forEach((line, index) => {
      tokens.push(...line.map((token) => ({ content: token.content, color: token.color })))
      if (index < endings.length) tokens.push({ content: endings[index] })
    })
    self.postMessage({ id, tokens })
  } catch {
    self.postMessage({ id, tokens: null })
  }
}
