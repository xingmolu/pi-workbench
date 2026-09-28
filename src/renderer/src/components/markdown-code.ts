import type { ComponentProps } from 'react'
import type { Components } from 'react-markdown'

type PreNode = ComponentProps<Exclude<Components['pre'], string | undefined>>['node']

export function codeBlockText(node: PreNode): string {
  const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code')
  if (!code || code.type !== 'element') return ''
  const value = code.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
  // mdast-to-hast appends one LF to a nonempty code value. Preserve all source whitespace.
  return value.endsWith('\n') ? value.slice(0, -1) : value
}
