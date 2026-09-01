import { createHash } from 'node:crypto'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('请输入网址')
  if (trimmed === 'about:blank') return trimmed

  const localAddress = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/#?]|$)/i.test(trimmed)
  const explicitScheme =
    /^(?:https?:|[a-z][a-z\d+.-]*:\/\/|(?:about|blob|data|file|javascript|mailto):)/i.test(trimmed)
  const candidate = localAddress
    ? `http://${trimmed}`
    : explicitScheme
      ? trimmed
      : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error('网址格式不正确，请输入完整域名')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('浏览器只允许打开 HTTP 或 HTTPS 页面')
  }
  if (url.username || url.password) throw new Error('网址中不能包含账号或密码')
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('非本地页面必须使用 HTTPS')
  }
  return url.toString()
}

export function browserPartitionForProject(projectPath: string): string {
  const hash = createHash('sha256').update(projectPath).digest('hex').slice(0, 20)
  return `persist:pi-browser-${hash}`
}

export function isAllowedBrowserKey(key: string): boolean {
  if (key.length === 1 && !/[\u0000-\u001f\u007f]/.test(key)) return true
  return new Set([
    'Enter',
    'Escape',
    'Tab',
    'Backspace',
    'Delete',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Space'
  ]).has(key)
}
