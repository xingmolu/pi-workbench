import { useLayoutEffect, useRef, useState } from 'react'
import type { WorkbenchCommand } from '../../../shared/contracts'
import { createSandboxedPluginPaneController } from './sandboxed-plugin-pane-controller'

type SandboxedPluginPaneProps = {
  viewId: string
  visible: boolean
  onWorkbenchCommand: (command: WorkbenchCommand) => Promise<void>
  onWorkbenchError: (message: string) => void
}

const clamp = (value: number, maximum: number): number =>
  Math.min(maximum, Math.max(0, Math.round(value)))

export default function SandboxedPluginPane({
  viewId,
  visible,
  onWorkbenchCommand,
  onWorkbenchError
}: SandboxedPluginPaneProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [unavailable, setUnavailable] = useState(false)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    let frame = 0
    const controller = createSandboxedPluginPaneController({
      viewId,
      send: onWorkbenchCommand,
      onUnavailableChange: setUnavailable,
      onError: onWorkbenchError
    })

    if (!viewport || !visible) {
      controller.dispose()
      return () => controller.dispose()
    }

    const publishBounds = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = viewport.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) {
          controller.suspend()
          return
        }
        controller.publish({
          x: clamp(rect.x, 100_000),
          y: clamp(rect.y, 100_000),
          width: Math.max(1, clamp(rect.width, 16_384)),
          height: Math.max(1, clamp(rect.height, 16_384))
        })
      })
    }

    const observer = new ResizeObserver(publishBounds)
    observer.observe(viewport)
    const workspace = viewport.closest('.workspace-panels')
    if (workspace) observer.observe(workspace)
    window.addEventListener('resize', publishBounds)
    publishBounds()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', publishBounds)
      controller.dispose()
    }
  }, [onWorkbenchCommand, onWorkbenchError, viewId, visible])

  return (
    <div className="sandboxed-plugin-pane" ref={viewportRef}>
      {visible && unavailable ? <div role="status">插件面板暂不可用。</div> : null}
    </div>
  )
}
