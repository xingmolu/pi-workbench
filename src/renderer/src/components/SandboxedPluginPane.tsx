import { useLayoutEffect, useRef, useState } from 'react'

type SandboxedPluginPaneProps = {
  viewId: string
  visible: boolean
}

const clamp = (value: number, maximum: number): number =>
  Math.min(maximum, Math.max(0, Math.round(value)))

export default function SandboxedPluginPane({
  viewId,
  visible
}: SandboxedPluginPaneProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [unavailable, setUnavailable] = useState(false)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    let active = true
    let frame = 0
    let request = 0

    const hide = (): void => {
      request += 1
      void window.pi.workbench({ type: 'view:set', viewId, visible: false }).catch(() => undefined)
    }

    if (!viewport || !visible) {
      hide()
      return hide
    }

    const publishBounds = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = viewport.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) {
          hide()
          return
        }
        const currentRequest = ++request
        void window.pi
          .workbench({
            type: 'view:set',
            viewId,
            visible: true,
            bounds: {
              x: clamp(rect.x, 100_000),
              y: clamp(rect.y, 100_000),
              width: Math.max(1, clamp(rect.width, 16_384)),
              height: Math.max(1, clamp(rect.height, 16_384))
            }
          })
          .then(() => {
            if (active && currentRequest === request) setUnavailable(false)
          })
          .catch(() => {
            if (active && currentRequest === request) setUnavailable(true)
          })
      })
    }

    const observer = new ResizeObserver(publishBounds)
    observer.observe(viewport)
    window.addEventListener('resize', publishBounds)
    publishBounds()
    return () => {
      active = false
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', publishBounds)
      hide()
    }
  }, [viewId, visible])

  return (
    <div className="sandboxed-plugin-pane" ref={viewportRef}>
      {visible && unavailable ? <div role="status">插件面板暂不可用。</div> : null}
    </div>
  )
}
