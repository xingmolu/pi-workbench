import type { SessionManager, SessionEntry } from '@earendil-works/pi-coding-agent'
import {
  MESSAGE_FEEDBACK_TYPE,
  messageFeedbackDataSchema,
  type MessageFeedbackCommand
} from '../shared/message-actions'
import { SessionRuntimeUnsafeError } from './session-mutation-safety'
import { t } from '../shared/i18n'

export function isCompletedAssistant(entry: SessionEntry | undefined): boolean {
  return (
    entry?.type === 'message' &&
    entry.message.role === 'assistant' &&
    (entry.message.stopReason === 'stop' || entry.message.stopReason === 'length') &&
    !entry.message.content.some((block) => block.type === 'toolCall')
  )
}

export function recordMessageFeedback(
  target: MessageFeedbackCommand,
  state: { manager: SessionManager; sessionId: string; generation: number; reason: string | null }
): void {
  if (target.sessionId !== state.sessionId || target.generation !== state.generation)
    throw new Error(t('会话已变化，未记录反馈'))
  if (state.reason) throw new Error(state.reason)
  const branch = state.manager.getBranch()
  if (!isCompletedAssistant(branch.find((entry) => entry.id === target.entryId)))
    throw new Error(t('仅能为当前分支中已完成的助手回复记录反馈'))
  let current: MessageFeedbackCommand['value'] = null
  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== MESSAGE_FEEDBACK_TYPE) continue
    const parsed = messageFeedbackDataSchema.safeParse(entry.data)
    if (parsed.success && parsed.data.entryId === target.entryId) current = parsed.data.value
  }
  if (current === target.value) return
  try {
    state.manager.appendCustomEntry(MESSAGE_FEEDBACK_TYPE, {
      entryId: target.entryId,
      value: target.value
    })
  } catch (cause) {
    throw new SessionRuntimeUnsafeError(
      t('反馈保存结果无法确认，运行时已停止；请重新连接后读取记录，不要直接重试。'),
      { cause }
    )
  }
}
