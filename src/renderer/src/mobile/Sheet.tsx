import { useEffect, useId, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

/** A bottom sheet: the phone's picker for models, permissions, skills and confirmations. */
export function Sheet({
  title,
  onClose,
  children
}: {
  title: string
  onClose: () => void
  children: ReactNode
}): React.JSX.Element {
  const id = useId()
  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [onClose])
  // Portaled so no ancestor's stacking context or overflow can cover it.
  return createPortal(
    <div className="m-sheet-layer">
      <button type="button" className="m-sheet-backdrop" aria-label="关闭" onClick={onClose} />
      <section className="m-sheet" role="dialog" aria-modal="true" aria-labelledby={id}>
        <header>
          <h2 id={id}>{title}</h2>
          <button type="button" className="m-icon" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="m-sheet-body">{children}</div>
      </section>
    </div>,
    document.body
  )
}
