import type { ThinkingLevel } from '../../../shared/contracts'
import { t } from '../../../shared/i18n'

/** Short, human names for reasoning effort, in the order Pi defines them. */
export const THINKING_LABEL: Record<ThinkingLevel, string> = {
  off: t('关闭'),
  minimal: t('极低'),
  low: t('低'),
  medium: t('中'),
  high: t('高'),
  xhigh: t('很高'),
  max: t('最高')
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

/** Known model families, matched against the model ID after any `vendor/` prefix. */
const FAMILIES: { id: string; label: string; pattern: RegExp }[] = [
  { id: 'claude', label: 'Claude', pattern: /claude/ },
  { id: 'gpt', label: 'GPT', pattern: /^(gpt|chatgpt|o\d|codex)|[/-](gpt|o\d)(-|$)/ },
  { id: 'gemini', label: 'Gemini', pattern: /gemini|gemma/ },
  { id: 'deepseek', label: 'DeepSeek', pattern: /deepseek/ },
  { id: 'qwen', label: 'Qwen', pattern: /qwen|qwq/ },
  { id: 'kimi', label: 'Kimi', pattern: /kimi|moonshot/ },
  { id: 'glm', label: 'GLM', pattern: /glm|chatglm|zhipu/ },
  { id: 'grok', label: 'Grok', pattern: /grok/ },
  { id: 'llama', label: 'Llama', pattern: /llama/ },
  { id: 'mistral', label: 'Mistral', pattern: /mistral|mixtral|codestral|devstral|magistral/ },
  { id: 'doubao', label: t('豆包'), pattern: /doubao/ },
  { id: 'minimax', label: 'MiniMax', pattern: /minimax|abab/ }
]

export type ModelFamilyGroup<T> = { id: string; label: string; models: T[] }

/** Smaller lists read better flat; a gateway's long list is split by model family. */
export const FAMILY_GROUPING_MIN = 12

export function modelFamily(model: { id: string; name?: string }): {
  id: string
  label: string
} {
  const text = `${model.id} ${model.name ?? ''}`.toLowerCase()
  const family = FAMILIES.find((item) => item.pattern.test(text))
  return family ? { id: family.id, label: family.label } : { id: 'other', label: t('其他') }
}

/**
 * Groups one account's models by family, in the order families are listed above, with
 * the rest last. Returns a single unlabeled group when grouping would not help.
 */
export function groupModelsByFamily<T extends { id: string; name?: string }>(
  models: readonly T[]
): ModelFamilyGroup<T>[] {
  const groups = new Map<string, ModelFamilyGroup<T>>()
  for (const model of models) {
    const family = modelFamily(model)
    const group = groups.get(family.id) ?? { ...family, models: [] }
    group.models.push(model)
    groups.set(family.id, group)
  }
  if (models.length < FAMILY_GROUPING_MIN || groups.size < 2)
    return [{ id: 'all', label: '', models: [...models] }]
  const order = [...FAMILIES.map((family) => family.id), 'other']
  return [...groups.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
}
