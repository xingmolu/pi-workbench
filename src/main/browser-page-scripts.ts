/** Fixed bounded read in the isolated world, never a caller-supplied script. */
export function pageContainsTextScript(text: string): string {
  return `(() => { const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT); let content = '', visited = 0, node; while ((node = walker.nextNode()) && visited++ < 4000 && content.length < 100000) content += node.textContent.slice(0, 100000 - content.length); return content.includes(${JSON.stringify(text.slice(0, 10000))}); })()`
}
