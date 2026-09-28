const mac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')

/** Shortcut text for this platform: ⌘N on macOS, Ctrl+N elsewhere. */
export function shortcutLabel(key: string): string {
  return mac ? `⌘${key}` : `Ctrl+${key}`
}
