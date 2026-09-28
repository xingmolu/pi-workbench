/** Short Chinese age of a timestamp: 今天, N天, or a month/day date past a month. */
export function relativeTime(value: string): string {
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86400000))
  return days === 0
    ? '今天'
    : days < 30
      ? `${days}天`
      : new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
