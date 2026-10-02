import type { CustomEndpointContext } from '../shared/custom-endpoints'
import type { ComposeBlockReason } from '../shared/contracts'
import { t } from '../shared/i18n'

/** Separate latches: a successful refresh cannot silently accept an invalidated selection. */
export class EndpointSessionSafety {
  private target: Pick<CustomEndpointContext, 'sessionId' | 'generation'> | null = null
  private runtimeSyncFailed = false
  private selectionInvalidated = false

  private matches(target: Pick<CustomEndpointContext, 'sessionId' | 'generation'>): boolean {
    return (
      this.target?.sessionId === target.sessionId && this.target?.generation === target.generation
    )
  }
  bind(target: Pick<CustomEndpointContext, 'sessionId' | 'generation'>): void {
    this.target = { sessionId: target.sessionId, generation: target.generation }
    this.runtimeSyncFailed = false
    this.selectionInvalidated = false
  }
  setRuntimeBlocked(
    target: Pick<CustomEndpointContext, 'sessionId' | 'generation'>,
    blocked: boolean
  ): void {
    if (this.matches(target)) this.runtimeSyncFailed = blocked
  }
  invalidate(target: Pick<CustomEndpointContext, 'sessionId' | 'generation'>): void {
    if (this.matches(target)) this.selectionInvalidated = true
  }
  selected(target: Pick<CustomEndpointContext, 'sessionId' | 'generation'>): void {
    if (this.matches(target)) this.selectionInvalidated = false
  }
  reason(target: Pick<CustomEndpointContext, 'sessionId' | 'generation'>): ComposeBlockReason {
    if (!this.matches(target)) return null
    if (this.runtimeSyncFailed) return 'endpoint-runtime-unsynchronized'
    if (this.selectionInvalidated) return 'endpoint-selection-invalidated'
    return null
  }
}

export function assertEndpointContext(
  expected: CustomEndpointContext,
  current: CustomEndpointContext
): void {
  if (
    expected.projectPath !== current.projectPath ||
    expected.sessionId !== current.sessionId ||
    expected.generation !== current.generation
  )
    throw new Error(t('工作区或会话已切换，请重新打开端点编辑器'))
}
