import type { AgentRuntimeManifest } from '../../../shared/agent-runtime'
import { t } from '../../../shared/i18n'

/** One line on what an engine is good for, the same in the sidebar menu and Settings. */
export function engineSummary(runtime: AgentRuntimeManifest): string {
  if (runtime.id === 'codex') return t('OpenAI Codex，用 Pi 的 ChatGPT 账号')
  return runtime.subagents === 'native'
    ? t('Claude 原生能力，原生子 Agent')
    : t('多家模型与 API，桌面子 Agent')
}
