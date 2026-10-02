import type { ApprovalRequest, ConversationNode, UsageMetrics } from '../../../shared/contracts'
import { t } from '../../../shared/i18n'

export function currentToolApproval(
  node: Extract<ConversationNode, { type: 'tool' }>,
  approvals: readonly ApprovalRequest[]
): ApprovalRequest | null {
  return node.status === 'awaiting-approval'
    ? (approvals.find((request) => request.toolCallId === node.toolCallId) ?? null)
    : null
}

export function approvalSummary(approval: ApprovalRequest): string {
  if (approval.intent === 'web') {
    try {
      const input = JSON.parse(approval.detail)
      const actions: Record<string, string> = {
        new_tab: t('打开新网页'),
        navigate: t('前往网页'),
        click: t('点击网页元素'),
        fill: t('填写网页内容'),
        select: t('选择网页选项'),
        keypress: t('向网页发送按键'),
        close_tab: t('关闭网页'),
        reload: t('重新加载网页'),
        back: t('网页后退'),
        forward: t('网页前进')
      }
      const action = actions[input.action] ?? t('操作网页')
      return typeof input.url === 'string' ? `${action} · ${new URL(input.url).hostname}` : action
    } catch {
      return t('操作右侧浏览器中的网页')
    }
  }
  if (approval.intent === 'desktop') {
    try {
      const input = JSON.parse(approval.detail)
      if (input.action === 'act') {
        if (input.intent === 'type' && typeof input.text === 'string')
          return t('在桌面应用中输入「{value}」', {
            value: input.text.length > 40 ? `${input.text.slice(0, 40)}…` : input.text
          })
        if (input.intent === 'key' && typeof input.key === 'string')
          return t('在桌面应用中按 {key}', { key: input.key })
        if (input.intent === 'move') return t('移动桌面指针')
        return t('点击桌面应用中的控件')
      }
      const actions: Record<string, string> = {
        click: t('点击桌面坐标'),
        move: t('移动桌面指针'),
        type: t('向桌面输入文字')
      }
      const action = actions[input.action] ?? t('操作本机桌面')
      return typeof input.x === 'number' && typeof input.y === 'number'
        ? `${action} · (${input.x}, ${input.y})`
        : action
    } catch {
      return t('在确认后操作本机桌面')
    }
  }
  return approval.intent === 'diff'
    ? t('修改项目文件')
    : approval.intent === 'terminal'
      ? t('运行本地命令')
      : approval.title
}

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
    metrics.contextTokens === undefined ? t('未知') : `${formatTokens(metrics.contextTokens)} token`
  const window =
    metrics.contextWindow === undefined ? t('未知') : `${formatTokens(metrics.contextWindow)} token`
  return {
    percent,
    tokens,
    window,
    ariaLabel:
      percent === null
        ? t('上下文用量未知')
        : t('上下文已用 {value}%', { value: percent.toFixed(0) })
  }
}

export function runtimeMetricsDisplay(metrics: UsageMetrics): [label: string, value: string][] {
  return [
    [
      t('模型用时'),
      metrics.llmDurationMs === undefined ? t('未知') : formatDuration(metrics.llmDurationMs)
    ],
    [
      t('平均首 token'),
      metrics.firstTokenMs === undefined ? t('未知') : formatDuration(metrics.firstTokenMs)
    ],
    [
      t('生成速度'),
      metrics.usageIncomplete || metrics.tokensPerSecond === undefined
        ? t('未知')
        : `${metrics.tokensPerSecond.toFixed(1)} tok/s`
    ]
  ]
}

export function composerStatsDisplay(metrics: UsageMetrics): string[] | null {
  if (!metrics.turns && !metrics.input && !metrics.output) return null

  if (metrics.usageIncomplete) metrics = { ...metrics, tokensPerSecond: undefined }
  const promptTokens = metrics.input + metrics.cacheRead + metrics.cacheWrite
  const groups = [t('{turns}轮 · {steps}步', { turns: metrics.turns, steps: metrics.steps })]
  if (metrics.llmDurationMs !== undefined) {
    groups.push(`LLM ${formatDuration(metrics.llmDurationMs)}`)
  }
  if (metrics.firstTokenMs !== undefined) {
    const speed =
      metrics.tokensPerSecond === undefined ? '' : ` · ${metrics.tokensPerSecond.toFixed(0)} tok/s`
    groups.push(
      t('平均首 token {value}{speed}', { value: formatDuration(metrics.firstTokenMs), speed })
    )
  } else if (metrics.tokensPerSecond !== undefined) {
    groups.push(t('生成速度 {value} tok/s', { value: metrics.tokensPerSecond.toFixed(0) }))
  }
  if (promptTokens > 0) {
    const hit = (metrics.cacheRead / promptTokens) * 100
    groups.push(t('缓存命中 {value}%', { value: hit.toFixed(0) }))
  }
  groups.push(
    t('输入 {value} tok · 输出 {value2} tok', {
      value: formatTokens(promptTokens),
      value2: formatTokens(metrics.output)
    })
  )
  if (metrics.usageIncomplete) groups.push(t('中断用量未知 · 累计仅含已报告用量'))
  return groups
}

export function toolMetaDisplay(node: Extract<ConversationNode, { type: 'tool' }>): string[] {
  const meta: string[] = []
  if (node.durationMs !== undefined) meta.push(formatDuration(node.durationMs))
  if (node.truncated) {
    meta.push(
      node.originalOutputLength === undefined
        ? t('已截断')
        : t('已截断 · 原始 {value} 字符', {
            value: node.originalOutputLength.toLocaleString('zh-CN')
          })
    )
  }
  return meta
}
