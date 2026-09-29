import type { ThinkingLevel } from '../../../shared/contracts'

/** Short, human names for reasoning effort, in the order Pi defines them. */
export const THINKING_LABEL: Record<ThinkingLevel, string> = {
  off: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高'
}

/** 200000 → "200K", 1000000 → "1M": how much a model can read at once. */
export function contextLabel(tokens: number): string {
  if (!tokens) return ''
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  return `${Math.round(tokens / 1000)}K`
}

const RECENT_KEY = 'pi-desktop-recent-models'
const RECENT_LIMIT = 4

/** Most recently chosen models first, as `provider:model` keys; per device, best effort. */
export function recentModels(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 8) : []
  } catch {
    return []
  }
}

export function rememberModel(provider: string, model: string): void {
  const key = `${provider}:${model}`
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([key, ...recentModels().filter((item) => item !== key)].slice(0, RECENT_LIMIT))
    )
  } catch {
    /* Recents are a convenience only. */
  }
}
