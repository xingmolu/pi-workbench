import { useEffect, useRef, useState } from 'react'
import { Palette } from 'lucide-react'
import type { MobileThemeChoice } from './theme'
import { t } from '../../../shared/i18n'

const CHOICES: [MobileThemeChoice, string][] = [
  ['system', t('跟随系统')],
  ['dark', t('深色')],
  ['light', t('浅色')]
]

export function ThemeButton({
  choice,
  onChoice
}: {
  choice: MobileThemeChoice
  onChoice: (choice: MobileThemeChoice) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: Event): void => {
      if (
        event instanceof KeyboardEvent
          ? event.key === 'Escape'
          : !root.current?.contains(event.target as Node)
      )
        setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])
  return (
    <div className="m-theme" ref={root}>
      <button
        type="button"
        className="m-icon"
        aria-label={t('主题')}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Palette size={18} />
      </button>
      {open ? (
        <div className="m-menu" role="menu">
          {CHOICES.map(([value, label]) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={choice === value}
              key={value}
              onClick={() => {
                onChoice(value)
                setOpen(false)
              }}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
