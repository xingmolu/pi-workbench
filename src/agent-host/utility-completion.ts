import type { AssistantMessage, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { t } from '../shared/i18n'
import {
  UTILITY_ATTEMPT_TIMEOUT_MS,
  UTILITY_LIMITS,
  utilityModelCandidates,
  type UtilityCompleteCommand,
  type UtilityCompletion
} from '../shared/utility-model'

/** The part of Pi's ModelRuntime a utility generation uses. */
export type UtilityModelRuntime = {
  completeSimple(
    model: Model<string>,
    context: Context,
    options?: SimpleStreamOptions
  ): Promise<AssistantMessage>
}

/**
 * One generation outside any conversation. Candidates are tried in order and a model that
 * fails, times out or answers nothing falls through to the next, so a slow or signed-out
 * small model never blocks the request when the session's own model would answer.
 */
export async function runUtilityCompletion(
  runtime: UtilityModelRuntime,
  available: readonly Model<string>[],
  request: UtilityCompleteCommand,
  options: { attemptTimeoutMs?: number } = {}
): Promise<UtilityCompletion> {
  const candidates = utilityModelCandidates(available, request)
  if (candidates.length === 0)
    throw new Error(t('没有可用于生成的模型：请先在「设置 › 引擎与账号」连接一个账号或 API'))
  let failure: unknown = null
  for (const candidate of candidates) {
    const model = available.find(
      (item) => item.provider === candidate.providerId && item.id === candidate.modelId
    )
    if (!model) continue
    try {
      const message = await runtime.completeSimple(
        model,
        {
          ...(request.system ? { systemPrompt: request.system } : {}),
          messages: [{ role: 'user', content: request.prompt, timestamp: Date.now() }]
        },
        {
          maxTokens: Math.min(request.maxTokens, model.maxTokens || request.maxTokens),
          signal: AbortSignal.timeout(options.attemptTimeoutMs ?? UTILITY_ATTEMPT_TIMEOUT_MS),
          maxRetries: 0
        }
      )
      if (message.stopReason === 'error' || message.stopReason === 'aborted')
        throw new Error(message.errorMessage || t('模型没有完成回答'))
      const text = message.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('')
        .trim()
      if (!text) throw new Error(t('模型没有返回文字'))
      return {
        text: text.slice(0, UTILITY_LIMITS.result),
        providerId: model.provider,
        modelId: model.id
      }
    } catch (error) {
      failure = error
    }
  }
  const reason = failure instanceof Error ? failure.message : String(failure)
  throw new Error(t('生成失败：{reason}', { reason }))
}
