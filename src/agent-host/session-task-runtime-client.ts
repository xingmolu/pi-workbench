import { readAgentSessionIdentity, subscribeAgentSessionIdentity } from './agent-session-identity'
import { SessionTaskCapabilityClient } from './session-task-capability-client'
import { t } from '../shared/i18n'

let client: SessionTaskCapabilityClient | null = null
let unsubscribeIdentity: (() => void) | null = null

export function getSessionTaskCapabilityClient(): SessionTaskCapabilityClient {
  if (client) return client
  client = new SessionTaskCapabilityClient({
    send: (message) => process.parentPort.postMessage(message),
    identity: readAgentSessionIdentity
  })
  unsubscribeIdentity = subscribeAgentSessionIdentity((identity, previous) => {
    if (!previous) return
    if (identity?.sessionId === previous.sessionId && identity?.generation === previous.generation)
      return
    client?.rejectAll(
      t('父会话已切换；SessionTask 操作结果可能未知，请回到原会话后使用 supervise snapshot 核对')
    )
  })
  return client
}

export function acceptSessionTaskCapabilityResponse(message: unknown): boolean {
  return getSessionTaskCapabilityClient().accept(message)
}

/** Test/process teardown seam; production normally keeps one client per Agent Host process. */
export function disposeSessionTaskCapabilityClient(): void {
  unsubscribeIdentity?.()
  unsubscribeIdentity = null
  client?.rejectAll(t('Agent Host 已结束'))
  client = null
}
