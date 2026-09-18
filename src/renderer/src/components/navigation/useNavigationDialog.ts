import { useLayoutEffect, useRef } from 'react'
import { useOverlayState } from '../../store/overlay-state'

/** Suspend native surfaces before painting a modal and release only the owner we acquired. */
export function useNavigationDialog(): React.RefObject<HTMLElement | null> {
  const opener = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const owned = useOverlayState.getState().open('navigation')
    return () => {
      if (owned) useOverlayState.getState().close('navigation')
    }
  }, [])
  return opener
}
