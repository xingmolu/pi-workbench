/** Remote PWA composer: Enter sends, Shift+Enter inserts a newline. IME composition must not send. */
export function composerShouldSend(event: {
  key: string
  shiftKey?: boolean
  altKey?: boolean
  isComposing?: boolean
  keyCode?: number
}): boolean {
  if (event.key !== 'Enter') return false
  if (event.shiftKey || event.altKey) return false
  if (event.isComposing || event.keyCode === 229) return false
  return true
}

export function composeBlockChip(reason: string | null | undefined): string {
  if (!reason) return ''
  if (
    reason === 'model-required' ||
    reason === 'model-unavailable' ||
    reason === 'pinned-model-unavailable'
  ) {
    return '模型不可用'
  }
  return '暂时无法发送'
}
