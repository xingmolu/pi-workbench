import type { WorkbenchBounds, WorkbenchCommand } from '../../../shared/contracts'

type SandboxedPluginPaneControllerOptions = {
  viewId: string
  send(command: WorkbenchCommand): Promise<unknown>
  onUnavailableChange(unavailable: boolean): void
}

export type SandboxedPluginPaneController = {
  publish(bounds: WorkbenchBounds): void
  dispose(): void
}

export function createSandboxedPluginPaneController(
  options: SandboxedPluginPaneControllerOptions
): SandboxedPluginPaneController {
  let disposed = false
  let generation = 0
  let inFlight = false
  let queuedBounds: WorkbenchBounds | null = null

  const sendVisible = (bounds: WorkbenchBounds): void => {
    inFlight = true
    const requestGeneration = generation
    let request: Promise<unknown>
    try {
      request = Promise.resolve(
        options.send({ type: 'view:set', viewId: options.viewId, visible: true, bounds })
      )
    } catch (error) {
      request = Promise.reject(error)
    }

    void request.then(
      () => complete(requestGeneration, false),
      () => complete(requestGeneration, true)
    )
  }

  const complete = (requestGeneration: number, unavailable: boolean): void => {
    if (disposed || requestGeneration !== generation) return
    inFlight = false
    options.onUnavailableChange(unavailable)
    const nextBounds = queuedBounds
    queuedBounds = null
    if (nextBounds) sendVisible(nextBounds)
  }

  return {
    publish(bounds) {
      if (disposed) return
      if (inFlight) {
        queuedBounds = bounds
        return
      }
      sendVisible(bounds)
    },
    dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      queuedBounds = null
      try {
        void Promise.resolve(
          options.send({ type: 'view:set', viewId: options.viewId, visible: false })
        ).catch(() => undefined)
      } catch {
        // Hiding is best-effort while the owning React tree is being removed.
      }
    }
  }
}
