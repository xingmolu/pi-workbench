import type { ConversationNode, UsageMetrics } from '../../../shared/contracts'

export type ContextDisplay = {
  percent: number | null
  tokens: string
  window: string
  ariaLabel: string
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}K`
  return `${(value / 1_000_000).toFixed(1)}M`
}

export function formatDuration(value: number): string {
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`
}

export function contextDisplay(metrics: UsageMetrics): ContextDisplay {
  const hasPercent = metrics.contextPercent !== undefined && Number.isFinite(metrics.contextPercent)
  const percent = hasPercent ? Math.max(0, Math.min(100, metrics.contextPercent!)) : null
  const tokens =
    metrics.contextTokens === undefined ? '未知' : `${formatTokens(metrics.contextTokens)} token`
  const window =
    metrics.contextWindow === undefined ? '未知' : `${formatTokens(metrics.contextWindow)} token`
  return {
    percent,
    tokens,
    window,
    ariaLabel: percent === null ? '上下文用量未知' : `上下文已用 ${percent.toFixed(0)}%`
  }
}

export function runtimeMetricsDisplay(metrics: UsageMetrics): [label: string, value: string][] {
  return [
    [
      '模型用时',
      metrics.llmDurationMs === undefined ? '未知' : formatDuration(metrics.llmDurationMs)
    ],
    [
      '平均首 token',
      metrics.firstTokenMs === undefined ? '未知' : formatDuration(metrics.firstTokenMs)
    ],
    [
      '生成速度',
      metrics.tokensPerSecond === undefined ? '未知' : `${metrics.tokensPerSecond.toFixed(1)} tok/s`
    ]
  ]
}

export function composerStatsDisplay(metrics: UsageMetrics): string[] | null {
  if (!metrics.turns && !metrics.input && !metrics.output) return null

  const promptTokens = metrics.input + metrics.cacheRead + metrics.cacheWrite
  const groups = [`${metrics.turns}轮 · ${metrics.steps}步`]
  if (metrics.llmDurationMs !== undefined) {
    groups.push(`LLM ${formatDuration(metrics.llmDurationMs)}`)
  }
  if (metrics.firstTokenMs !== undefined) {
    const speed =
      metrics.tokensPerSecond === undefined ? '' : ` · ${metrics.tokensPerSecond.toFixed(0)} tok/s`
    groups.push(`平均首 token ${formatDuration(metrics.firstTokenMs)}${speed}`)
  } else if (metrics.tokensPerSecond !== undefined) {
    groups.push(`生成速度 ${metrics.tokensPerSecond.toFixed(0)} tok/s`)
  }
  if (promptTokens > 0) {
    const hit = (metrics.cacheRead / promptTokens) * 100
    groups.push(`缓存命中 ${hit.toFixed(0)}%`)
  }
  groups.push(`输入 ${formatTokens(promptTokens)} tok · 输出 ${formatTokens(metrics.output)} tok`)
  return groups
}

export function toolMetaDisplay(node: Extract<ConversationNode, { type: 'tool' }>): string[] {
  const meta: string[] = []
  if (node.durationMs !== undefined) meta.push(formatDuration(node.durationMs))
  if (node.truncated) {
    meta.push(
      node.originalOutputLength === undefined
        ? '已截断'
        : `已截断 · 原始 ${node.originalOutputLength.toLocaleString('zh-CN')} 字符`
    )
  }
  return meta
}
