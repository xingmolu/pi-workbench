import { normalizeSessionName } from '../shared/session-name'
import { SessionRuntimeUnsafeError } from './session-mutation-safety'
import { t } from '../shared/i18n'
export { SessionMutationGuard as SessionPersistenceGuard } from './session-mutation-safety'

export class SessionRenamePersistenceError extends SessionRuntimeUnsafeError {
  constructor(cause: unknown) {
    super(t('会话名称保存失败，运行时已停止；请重新连接后重试'), { cause })
  }
}

export type SessionRenameTarget = {
  sessionId: string
  generation: number
  persisted: boolean
  busy: boolean
  promptPending: boolean
  currentName: string | undefined
}

export async function renameSession(
  request: { sessionId: string; generation: number; name: string },
  target: SessionRenameTarget | null,
  operations: {
    setSessionName: (name: string) => void
    refreshSessions: (generation: number) => Promise<boolean>
  }
): Promise<void> {
  const name = normalizeSessionName(request.name)
  if (
    !target ||
    target.sessionId !== request.sessionId ||
    target.generation !== request.generation
  ) {
    throw new Error(t('会话已切换，请重新打开重命名'))
  }
  if (!target.persisted) throw new Error(t('当前会话尚未保存，不能重命名'))
  if (target.busy || target.promptPending) throw new Error(t('当前会话正在运行，不能重命名'))
  if (target.currentName?.trim() === name) return
  try {
    operations.setSessionName(name)
  } catch (error) {
    // The SDK may mutate its entry indexes before appendFileSync throws. Never
    // reuse that runtime: reconnect must reload the canonical session from disk.
    throw new SessionRenamePersistenceError(error)
  }
  await operations.refreshSessions(target.generation)
}
