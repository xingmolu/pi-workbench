import type { ConversationNode, ModelSummary, SessionStatus } from '../shared/contracts'

export function projectRunStatus(input: {
  busy: boolean
  awaitingApproval: boolean
  stopped: boolean
  error?: string
}): SessionStatus {
  if (input.awaitingApproval) return 'awaiting-approval'
  // Pi's busy interval includes retry backoff; a failed attempt is not yet a failed run.
  if (input.busy) return 'running'
  if (input.stopped) return 'stopped'
  return input.error ? 'error' : 'idle'
}

type AssistantOutcome = {
  timestamp: number
  stopReason: string
  errorMessage?: string
}

// The canonical Pi stop reason, not an English error substring, owns cancellation semantics.
export function assistantTerminalNode(message: AssistantOutcome): ConversationNode | null {
  if (message.stopReason === 'aborted') {
    return {
      id: `stopped-${message.timestamp}`,
      type: 'stopped',
      message: '已停止生成，可继续对话'
    }
  }
  return message.errorMessage
    ? { id: `error-${message.timestamp}`, type: 'error', message: message.errorMessage }
    : null
}

export function measuredGenerationSpeed(timing: {
  llmDurationMs: number
  outputTokens: number
  usageIncomplete?: boolean
}): number | undefined {
  return !timing.usageIncomplete && timing.llmDurationMs > 0
    ? timing.outputTokens / (timing.llmDurationMs / 1000)
    : undefined
}

// In-memory negative capability evidence only. Never copy credentials or persist a transcript.
// Login clears the provider's evidence; ordinary auth/catalog refresh must not erase a rejection.
export class ModelRejections {
  private readonly rejected = new Map<string, string>()

  record(message: {
    provider: string
    model: string
    stopReason: string
    errorMessage?: string
  }): void {
    if (
      message.stopReason !== 'error' ||
      !(message.provider === 'openai-codex' || message.provider.startsWith('openai-codex-'))
    )
      return
    const match = message.errorMessage?.match(
      /The '([^']+)' model is not supported when using Codex with a ChatGPT account\./
    )
    if (match?.[1] !== message.model) return
    this.rejected.set(
      JSON.stringify([message.provider, message.model]),
      '服务端已确认：当前 ChatGPT 账号不支持此模型'
    )
  }

  project(model: ModelSummary): ModelSummary {
    const unavailableReason = this.rejected.get(JSON.stringify([model.provider, model.id]))
    return unavailableReason ? { ...model, unavailableReason } : model
  }

  clear(provider: string): void {
    for (const key of this.rejected.keys()) {
      if (JSON.parse(key)[0] === provider) this.rejected.delete(key)
    }
  }
}
