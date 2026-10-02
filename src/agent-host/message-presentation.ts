import type { ToolIntent } from '../shared/contracts'
import { t } from '../shared/i18n'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((item): item is { type: 'text'; text: string } => {
      return isRecord(item) && item.type === 'text' && typeof item.text === 'string'
    })
    .map((item) => item.text)
    .join('\n')
}

export function toolIntent(name: string): ToolIntent {
  if (name === 'bash' || name === 'powershell') return 'terminal'
  if (name === 'read' || name === 'ls') return 'read'
  if (name === 'write' || name === 'edit') return 'diff'
  if (name === 'grep' || name === 'find') return 'search'
  if (name === 'web' || name.includes('browser')) return 'web'
  if (name === 'computer' || name === 'desktop' || name === 'desktop-control') return 'desktop'
  return 'generic'
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function toolPresentation(
  name: string,
  rawArgs: unknown
): { title: string; detail: string } {
  const args = isRecord(rawArgs) ? rawArgs : {}
  const command = stringArg(args, 'command')
  const path = stringArg(args, 'path', 'filePath')
  const pattern = stringArg(args, 'pattern', 'query')
  const title =
    name === 'bash' || name === 'powershell'
      ? command?.split('\n')[0] || t('运行命令')
      : name === 'read'
        ? t('读取 {path}', { path: path ?? t('文件') })
        : name === 'ls'
          ? t('列出 {path}', { path: path ?? t('目录') })
          : name === 'write'
            ? t('写入 {path}', { path: path ?? t('文件') })
            : name === 'edit'
              ? t('编辑 {path}', { path: path ?? t('文件') })
              : name === 'grep' || name === 'find'
                ? t('搜索 {pattern}', { pattern: pattern ?? path ?? '' }).trim()
                : name === 'browser'
                  ? t('浏览器 · {action}', { action: stringArg(args, 'action') ?? t('操作') })
                  : name === 'computer'
                    ? `Computer Use · ${stringArg(args, 'action') ?? t('操作')}`
                    : name === 'desktop'
                      ? t('桌面 · {action}', { action: stringArg(args, 'action') ?? t('操作') })
                      : name

  let detail = ''
  try {
    detail = JSON.stringify(args, null, 2)
  } catch {
    detail = String(rawArgs ?? '')
  }
  return { title, detail }
}
