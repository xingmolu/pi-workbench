import { useState, type ReactNode } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { MoreHorizontal, type LucideIcon } from 'lucide-react'

export type RowAction = {
  id: string
  label: string
  icon: LucideIcon
  run: () => void
  reason?: string | null
  separator?: boolean
}

/** The visible overflow button, context click and Shift+F10 share exactly the same actions. */
export default function RowMenu({
  label,
  className,
  actions,
  children
}: {
  label: string
  className: string
  actions: RowAction[]
  children: ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div
      className={`navigation-row ${className}`}
      data-menu-open={open || undefined}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setOpen(true)
      }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          event.stopPropagation()
          setOpen(true)
        }
      }}
    >
      {children}
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            className="icon-btn navigation-more"
            type="button"
            aria-label={label}
            title={label}
          >
            <MoreHorizontal size={16} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="dropdown-content navigation-menu"
            sideOffset={4}
            align="start"
            collisionPadding={12}
            onCloseAutoFocus={(event) => {
              // A dialog opened from a menu item owns focus; do not bounce it back to the row.
              if (document.querySelector('[role="dialog"]')) event.preventDefault()
            }}
          >
            <DropdownMenu.Label className="dropdown-label">{label}</DropdownMenu.Label>
            {actions.map((action) => (
              <div key={action.id}>
                {action.separator && <DropdownMenu.Separator className="dropdown-separator" />}
                <DropdownMenu.Item
                  className="dropdown-item"
                  disabled={Boolean(action.reason)}
                  title={action.reason ?? undefined}
                  onSelect={action.run}
                >
                  <action.icon size={15} aria-hidden="true" />
                  <span>
                    <strong>{action.label}</strong>
                    {action.reason && <small>{action.reason}</small>}
                  </span>
                </DropdownMenu.Item>
              </div>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  )
}
