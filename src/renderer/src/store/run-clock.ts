import { useEffect, useState } from 'react'

/** When each session's current run was first seen busy; survives switching sessions. */
const startedAt = new Map<string, number>()

export function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = String(seconds % 60).padStart(2, '0')
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${rest}`
    : `${minutes}:${rest}`
}

/** Seconds the session has been running, ticking once a second; null when idle. */
export function useRunElapsed(sessionId: string | null, busy: boolean): number | null {
  const key = sessionId ?? ''
  if (busy && key && !startedAt.has(key)) startedAt.set(key, Date.now())
  if (!busy && key) startedAt.delete(key)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!busy) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [busy])
  const start = startedAt.get(key)
  return busy && start !== undefined ? Math.max(0, Math.floor((now - start) / 1000)) : null
}
