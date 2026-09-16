import { describe, expect, it } from 'vitest'
import type { ApprovalRequest, ConversationNode, UsageMetrics } from '../../../shared/contracts'
import {
  composerStatsDisplay,
  contextDisplay,
  runtimeMetricsDisplay,
  toolMetaDisplay,
  currentToolApproval,
  approvalSummary
} from './conversation-presentation'

const metrics = (overrides: Partial<UsageMetrics> = {}): UsageMetrics => ({
  turns: 0,
  steps: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ...overrides
})

it('assigns a reused tool ID approval only to the current awaiting occurrence', () => {
  const request: ApprovalRequest = {
    id: 'approval',
    toolCallId: 'reused',
    toolName: 'bash',
    intent: 'terminal',
    title: 'Run',
    detail: 'pwd',
    generation: 1
  }
  const tool: Extract<ConversationNode, { type: 'tool' }> = {
    id: 'current',
    type: 'tool',
    toolCallId: 'reused',
    name: 'bash',
    intent: 'terminal',
    title: 'Run',
    status: 'awaiting-approval'
  }
  const nodes = [{ ...tool, id: 'historical', status: 'success' as const }, tool]
  expect(nodes.map((node) => currentToolApproval(node, [request]))).toEqual([null, request])
})

it('summarizes desktop Ask the same way as browser Ask', () => {
  expect(
    approvalSummary({
      id: 'approval',
      generation: 1,
      toolCallId: 'click',
      toolName: 'desktop',
      intent: 'desktop',
      title: '桌面 · click',
      detail: JSON.stringify({ action: 'click', x: 12, y: 40 })
    })
  ).toBe('点击桌面坐标 · (12, 40)')
})

describe('contextDisplay', () => {
  it('keeps unknown context neutral instead of presenting 0%', () => {
    expect(contextDisplay(metrics())).toEqual({
      percent: null,
      tokens: '未知',
      window: '未知',
      ariaLabel: '上下文用量未知'
    })
  })

  it('presents known context usage from metrics', () => {
    expect(
      contextDisplay(
        metrics({ contextTokens: 12_400, contextWindow: 128_000, contextPercent: 9.7 })
      )
    ).toEqual({
      percent: 9.7,
      tokens: '12K token',
      window: '128K token',
      ariaLabel: '上下文已用 10%'
    })
  })
})

describe('toolMetaDisplay', () => {
  it('shows only measured duration and precise truncation metadata', () => {
    expect(
      toolMetaDisplay({
        id: 'tool-1',
        type: 'tool',
        toolCallId: '1',
        name: 'bash',
        intent: 'terminal',
        title: '运行命令',
        status: 'success',
        durationMs: 1_240,
        truncated: true,
        originalOutputLength: 15_432
      })
    ).toEqual(['1.2s', '已截断 · 原始 15,432 字符'])
  })

  it('does not invent missing duration or truncation', () => {
    expect(
      toolMetaDisplay({
        id: 'tool-2',
        type: 'tool',
        toolCallId: '2',
        name: 'read',
        intent: 'read',
        title: '读取文件',
        status: 'running'
      })
    ).toEqual([])
  })
})

describe('runtimeMetricsDisplay', () => {
  it('labels the aggregated first-token samples as an average', () => {
    expect(
      runtimeMetricsDisplay(
        metrics({ llmDurationMs: 2_400, firstTokenMs: 375.4, tokensPerSecond: 28.25 })
      )
    ).toEqual([
      ['模型用时', '2.4s'],
      ['平均首 token', '375ms'],
      ['生成速度', '28.3 tok/s']
    ])
  })
})

describe('composerStatsDisplay', () => {
  it('hides before the session has turns or input/output usage', () => {
    expect(composerStatsDisplay(metrics({ steps: 2, cacheRead: 500 }))).toBeNull()
  })

  it('summarizes only measured Pi and host metrics', () => {
    expect(
      composerStatsDisplay(
        metrics({
          turns: 2,
          steps: 3,
          input: 1_000,
          output: 550,
          cacheRead: 3_000,
          cacheWrite: 2_000,
          llmDurationMs: 2_200,
          firstTokenMs: 320,
          tokensPerSecond: 25.4
        })
      )
    ).toEqual([
      '2轮 · 3步',
      'LLM 2.2s',
      '平均首 token 320ms · 25 tok/s',
      '缓存命中 50%',
      '输入 6.0K tok · 输出 550 tok'
    ])
  })
})
