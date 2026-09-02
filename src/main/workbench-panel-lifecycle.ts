export type AbortableWorkbenchPanelLoad = {
  signal: AbortSignal
  load(): Promise<void>
  stop(): void
  destroy(): void
}

export async function loadAbortableWorkbenchPanel(
  lifecycle: AbortableWorkbenchPanelLoad
): Promise<void> {
  let destroyed = false
  const destroyOnce = (): void => {
    if (destroyed) return
    destroyed = true
    lifecycle.destroy()
  }
  const onAbort = (): void => {
    try {
      lifecycle.stop()
    } catch {
      // Stopping is best-effort; abort must still detach and close the panel.
    }
    destroyOnce()
  }

  lifecycle.signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (lifecycle.signal.aborted) onAbort()
    lifecycle.signal.throwIfAborted()
    await lifecycle.load()
    lifecycle.signal.throwIfAborted()
  } catch (error) {
    destroyOnce()
    throw error
  } finally {
    lifecycle.signal.removeEventListener('abort', onAbort)
  }
}
