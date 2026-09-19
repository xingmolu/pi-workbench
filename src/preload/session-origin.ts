import type { AgentSnapshot } from '../shared/contracts'
import type { DesktopCommandOrigin } from '../shared/session-runtime'

/** Captures ownership before IPC; late responses cannot change the next command's owner. */
export class SessionOriginTracker {
  private current?: DesktopCommandOrigin
  private epoch = 0

  accept(snapshot: Pick<AgentSnapshot, 'desktopScope' | 'desktopEpoch' | 'sessionId' | 'generation'>): void {
    const scope = snapshot.desktopScope
    const epoch = scope?.selectionEpoch ?? snapshot.desktopEpoch
    if (epoch !== undefined && epoch < this.epoch) return
    if (!scope) {
      if (epoch !== undefined) { this.epoch = epoch; this.current = undefined }
      return
    }
    this.epoch = scope.selectionEpoch
    const prior = this.current
    if (
      prior &&
      (scope.selectionEpoch < prior.scope.selectionEpoch ||
        (scope.selectionEpoch === prior.scope.selectionEpoch &&
          (scope.workerId !== prior.scope.workerId || snapshot.generation < prior.generation)))
    )
      return
    this.current = {
      scope: { ...scope },
      sessionId: snapshot.sessionId,
      generation: snapshot.generation
    }
  }

  capture(): DesktopCommandOrigin | undefined {
    return this.current && { ...this.current, scope: { ...this.current.scope } }
  }
}
