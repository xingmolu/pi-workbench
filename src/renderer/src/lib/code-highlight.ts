export type CodeToken = { content: string; color?: string }
export const MAX_CODE_CHARACTERS = 100_000
const aliases: Record<string, string> = {
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  javascript: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  sh: 'shellscript',
  bash: 'shellscript',
  shell: 'shellscript',
  shellscript: 'shellscript',
  py: 'python',
  python: 'python',
  css: 'css',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml'
}
export function highlightLanguage(language?: string, filename?: string): string | undefined {
  const key = (language || filename?.split('.').at(-1) || '').toLowerCase()
  return Object.hasOwn(aliases, key) ? aliases[key] : undefined
}
export function canHighlight(text: string): boolean {
  return (
    text.length <= MAX_CODE_CHARACTERS &&
    !text.split(/\r\n|\r|\n/).some((line) => line.length > 4000)
  )
}
let worker: Worker | undefined
let sequence = 0
const pending = new Map<
  number,
  { resolve: (tokens: CodeToken[] | null) => void; timer: ReturnType<typeof setTimeout> }
>()
const cache = new Map<string, CodeToken[]>()
let cacheCharacters = 0
function stopWorker(): void {
  worker?.terminate()
  worker = undefined
  for (const request of pending.values()) {
    clearTimeout(request.timer)
    request.resolve(null)
  }
  pending.clear()
}
/** One bounded worker shared by Markdown and file previews; no network or WASM. */
export async function highlightCode(text: string, language: string): Promise<CodeToken[] | null> {
  if (!canHighlight(text) || !highlightLanguage(language) || typeof Worker === 'undefined')
    return null
  const key = language + '\0' + text
  const cached = cache.get(key)
  if (cached) {
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }
  // A busy page cannot enqueue unbounded regex work.
  if (pending.size >= 16) return null
  try {
    if (!worker) {
      worker = new Worker(new URL('./code-highlight.worker.ts', import.meta.url), {
        type: 'module'
      })
      worker.onerror = stopWorker
      worker.onmessage = (event: MessageEvent<{ id: number; tokens: CodeToken[] | null }>) => {
        const request = pending.get(event.data.id)
        if (!request) return
        clearTimeout(request.timer)
        pending.delete(event.data.id)
        request.resolve(event.data.tokens)
      }
    }
    const tokens = await new Promise<CodeToken[] | null>((resolve) => {
      const id = ++sequence
      pending.set(id, { resolve, timer: setTimeout(stopWorker, 5000) })
      worker!.postMessage({ id, text, language })
    })
    // Never let tokenization normalize, truncate or otherwise replace source text.
    if (!tokens || tokens.map((token) => token.content).join('') !== text) return null
    if (!cache.has(key)) cacheCharacters += text.length
    cache.set(key, tokens)
    while (cache.size > 24 || cacheCharacters > 500_000) {
      const oldest = cache.keys().next().value!
      cacheCharacters -= oldest.length - oldest.indexOf('\0') - 1
      cache.delete(oldest)
    }
    return tokens
  } catch {
    stopWorker()
    return null
  }
}
