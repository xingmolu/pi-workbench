import type { SessionStatus } from './contracts'

/** Desktop ownership is independent of the host's native session and generation. */
export type SelectedSessionScope = { workerId: string; selectionEpoch: number }

export type LiveSessionSummary = {
  workerId: string
  cwd: string
  sessionPath: string | null
  sessionId: string | null
  generation: number | null
  status: SessionStatus | 'opening'
  selected: boolean
}

export function sameSelectedScope(
  left: SelectedSessionScope | null,
  right: SelectedSessionScope | null
): boolean {
  return left === null || right === null
    ? left === right
    : left.workerId === right.workerId && left.selectionEpoch === right.selectionEpoch
}
