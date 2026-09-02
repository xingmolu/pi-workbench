import type { WorkbenchBounds, WorkbenchCommand } from '../../../shared/contracts'

type SandboxedPluginPaneControllerOptions = {
  viewId: string
  send(command: WorkbenchCommand): Promise<unknown>
  onUnavailableChange(unavailable: boolean): void
  onError?(message: string): void
}

export type SandboxedPluginPaneController = {
  publish(bounds: WorkbenchBounds): void
  suspend(): void
  dispose(): void
}

function isExpectedHideCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /superseded|disposed|unavailable|no longer current/i.test(message)
}

export function createSandboxedPluginPaneController(
  options: SandboxedPluginPaneControllerOptions
): SandboxedPluginPaneController {
  let disposed = false
  let generation = 0
  let inFlight = false
  let queuedBounds: WorkbenchBounds | null = null
  let suspended = false

  const sendHide = (reportError: boolean): void => {
    try {
      void Promise.resolve(
        options.send({ type: 'view:set', viewId: options.viewId, visible: false })
      ).catch((error: unknown) => {
        if (reportError || !isExpectedHideCancellation(error)) {
          options.onError?.('无法隐藏插件面板。')
        }
      })
    } catch (error) {
      if (reportError || !isExpectedHideCancellation(error)) {
        options.onError?.('无法隐藏插件面板。')
      }
    }
  }

  const suspend = (): void => {
    if (disposed || suspended) return
    generation += 1
    inFlight = false
    queuedBounds = null
    suspended = true
    sendHide(true)
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
    if (unavailable) options.onError?.('插件面板暂不可用。')
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
      if (!suspended) {
        generation += 1
        inFlight = false
        queuedBounds = null
        suspended = true
        sendHide(false)
      }
      disposed = true
      generation += 1
      inFlight = false
      queuedBounds = null
    }
  }
}
