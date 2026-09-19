import type { LiveSessionRow } from './live-projects'

export const RECENT_SESSION_LIMIT = 5

/** Show the shortest useful suffix; the full authoritative path stays in the tooltip. */
export function sidebarPathHint(path: string, peers: string[]): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  let depth = Math.min(2, parts.length)
  while (
    depth < parts.length &&
    peers.some(
      (other) =>
        other !== path &&
        other.split(/[\\/]/).filter(Boolean).slice(-depth).join('/') ===
          parts.slice(-depth).join('/')
    )
  )
    depth++
  return parts.slice(-depth).join('/')
}

/** Keep active work and its parent/child SessionTask branch reachable when history is folded. */
export function sidebarSessions(sessions: LiveSessionRow[], expanded: boolean): LiveSessionRow[] {
  if (expanded) return sessions
  const taskParents = new Set(
    sessions.flatMap((session) =>
      session.sessionTask ? [session.sessionTask.parentWorkerId] : []
    )
  )
  return sessions.filter(
    (session, index) =>
      index < RECENT_SESSION_LIMIT ||
      session.pinned ||
      session.active ||
      Boolean(session.sessionTask) ||
      Boolean(session.workerId && taskParents.has(session.workerId)) ||
      (session.workerId && ['running', 'awaiting-approval', 'error'].includes(session.status))
  )
}
