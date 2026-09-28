import { useEffect, useRef, type RefObject } from 'react'

/**
 * When `open` turns true, bring the element into view with the least scrolling. Content
 * such as diffs can finish laying out a moment later, so growth in the first half second
 * is followed too. Closing, or rendering already open, never scrolls.
 */
export function useRevealOnOpen<T extends HTMLElement>(open: boolean): RefObject<T | null> {
  const element = useRef<T | null>(null)
  const wasOpen = useRef(open)
  useEffect(() => {
    const opened = open && !wasOpen.current
    wasOpen.current = open
    const target = element.current
    if (!opened || !target) return undefined
    const reveal = (): void => target.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    const frame = requestAnimationFrame(reveal)
    const observer = new ResizeObserver(reveal)
    observer.observe(target)
    const stop = setTimeout(() => observer.disconnect(), 500)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(stop)
      observer.disconnect()
    }
  }, [open])
  return element
}
