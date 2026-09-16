// Pierre imports `shiki`; the renderer alias routes that import to this supported
// fine-grained bundle. All grammar chunks are local and only these can load.
import { createBundledHighlighter, createSingletonShorthands } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
export * from 'shiki/core'
export { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
// Kept for Pierre's alternate-engine import contract; this app always uses JS.
export function createOnigurumaEngine(): never {
  throw new Error('Only the JavaScript highlighter is supported')
}
export const bundledLanguages = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs')
}
export const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: {},
  engine: () => createJavaScriptRegexEngine()
})
export const { codeToHtml } = createSingletonShorthands(createHighlighter)
