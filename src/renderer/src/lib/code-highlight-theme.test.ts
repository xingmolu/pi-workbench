import { expect, it, vi } from 'vitest'

it('keys the bounded highlighter cache by theme as well as language and source', async () => {
  vi.resetModules()
  const calls: string[] = []
  class TestWorker {
    onmessage?: (event: { data: { id: number; tokens: { content: string; color: string }[] } }) => void
    postMessage({ id, text, theme }: { id: number; text: string; theme: string }): void {
      calls.push(theme)
      queueMicrotask(() => this.onmessage?.({ data: { id, tokens: [{ content: text, color: theme === 'light' ? '#24292e' : '#e1e4e8' }] } }))
    }
    terminate(): void {}
  }
  vi.stubGlobal('Worker', TestWorker)
  try {
    const { highlightCode } = await import('./code-highlight')
    const dark = await highlightCode('const x = 1', 'typescript', 'dark')
    const light = await highlightCode('const x = 1', 'typescript', 'light')
    expect(light).not.toEqual(dark)
    expect(await highlightCode('const x = 1', 'typescript', 'dark')).toEqual(dark)
    expect(calls).toEqual(['dark', 'light'])
  } finally { vi.unstubAllGlobals() }
})
