import type { WorkbenchBounds, WorkbenchCommand } from '../../../shared/contracts'

type SandboxedPluginPaneControllerOptions = {
  viewId: string
  send(command: WorkbenchCommand): Promise<unknown>
  onUnavailableChange(unavailable: boolean): void
}

export type SandboxedPluginPaneController = {
  publish(bounds: WorkbenchBounds): void
  suspend(): void
  dispose(): void
}

export function createSandboxedPluginPaneController(
  options: SandboxedPluginPaneControllerOptions
): SandboxedPluginPaneController {
  let disposed = false
  let generation = 0
  let inFlight = false
  let queuedBounds: WorkbenchBounds | null = null
  let suspended = false

  const sendHide = (): void => {
    try {
      void Promise.resolve(
        options.send({ type: 'view:set', viewId: options.viewId, visible: false })
      ).catch(() => undefined)
    } catch {
      // Hiding is best-effort while the viewport or owning React tree is unavailable.
    }
  }

  const suspend = (): void => {
    if (disposed || suspended) return
    generation += 1
    inFlight = false
    queuedBounds = null
    suspended = true
    sendHide()
  }

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
      suspended = false
      if (inFlight) {
        queuedBounds = bounds
        return
      }
      sendVisible(bounds)
    },
    suspend,
    dispose() {
      if (disposed) return
      suspend()
      disposed = true
      generation += 1
      inFlight = false
      queuedBounds = null
    }
  }
}
