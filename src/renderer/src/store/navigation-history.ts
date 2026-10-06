/** A place the back and forward buttons can return to. */
export type HistoryLocation =
  { kind: 'session'; cwd: string; path: string } | { kind: 'page'; viewId: string }

export type NavigationHistory = { entries: HistoryLocation[]; index: number }

export const EMPTY_HISTORY: NavigationHistory = { entries: [], index: -1 }
const LIMIT = 50

export function sameLocation(a: HistoryLocation | null, b: HistoryLocation | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  return a.kind === 'page'
    ? a.viewId === (b as typeof a).viewId
    : a.cwd === (b as typeof a).cwd && a.path === (b as typeof a).path
}

/** Records arriving somewhere. Arriving where the history already points changes nothing,
 * so stepping back or forward does not record the step again. */
export function visit(history: NavigationHistory, location: HistoryLocation): NavigationHistory {
  if (sameLocation(history.entries[history.index] ?? null, location)) return history
  const entries = [...history.entries.slice(0, history.index + 1), location].slice(-LIMIT)
  return { entries, index: entries.length - 1 }
}

/** Moves back (-1) or forward (+1), skipping places that no longer exist. */
export function step(
  history: NavigationHistory,
  delta: -1 | 1,
  exists: (location: HistoryLocation) => boolean = () => true
): { history: NavigationHistory; target: HistoryLocation } | null {
  for (
    let index = history.index + delta;
    index >= 0 && index < history.entries.length;
    index += delta
  ) {
    const target = history.entries[index]
    if (exists(target)) return { history: { ...history, index }, target }
  }
  return null
}

export function canStep(
  history: NavigationHistory,
  delta: -1 | 1,
  exists?: (location: HistoryLocation) => boolean
): boolean {
  return step(history, delta, exists) !== null
}
