import type { PluginLogLine } from '../shared/plugin-install'

const MAX_LINES = 500
const MAX_LINE_CHARS = 2000

/**
 * The recent output of each plugin: its process's stdout and stderr, its panels' console,
 * and why it failed to load or stopped. Kept in memory only, for the developer reading it
 * in Settings; nothing is written to disk.
 */
export class PluginLogs {
  private readonly lines = new Map<string, PluginLogLine[]>()
  /** Output arrives in chunks; a partial last line waits for the rest. */
  private readonly partial = new Map<string, string>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Appends process output, which may hold several lines or part of one. */
  write(pluginId: string, stream: 'out' | 'err', chunk: string): void {
    const key = `${pluginId}\0${stream}`
    const text = (this.partial.get(key) ?? '') + chunk
    const parts = text.split(/\r?\n/)
    const rest = parts.pop() ?? ''
    if (rest.length > MAX_LINE_CHARS) {
      parts.push(rest)
      this.partial.delete(key)
    } else if (rest) this.partial.set(key, rest)
    else this.partial.delete(key)
    for (const line of parts)
      if (line) this.append(pluginId, stream === 'err' ? 'error' : 'info', line)
  }

  append(pluginId: string, level: PluginLogLine['level'], text: string, source?: string): void {
    const list = this.lines.get(pluginId) ?? []
    list.push({
      at: this.now(),
      level,
      text: text.slice(0, MAX_LINE_CHARS),
      ...(source ? { source } : {})
    })
    if (list.length > MAX_LINES) list.splice(0, list.length - MAX_LINES)
    this.lines.set(pluginId, list)
  }

  get(pluginId: string): PluginLogLine[] {
    return [...(this.lines.get(pluginId) ?? [])]
  }

  clear(pluginId: string): void {
    this.lines.delete(pluginId)
    for (const key of [...this.partial.keys()])
      if (key.startsWith(`${pluginId}\0`)) this.partial.delete(key)
  }
}
