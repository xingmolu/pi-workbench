import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { t } from '../../../shared/i18n'
import '../assets/settings-primitives.css'

/** A settings page: title, optional one-line description, then groups. */
export function SettingsPage({
  title,
  description,
  children
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="sp-page">
      <header className="sp-page-header">
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </header>
      {children}
    </section>
  )
}

/** A titled card of rows. */
export function SettingsGroup({
  title,
  description,
  children
}: {
  title?: string
  description?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="sp-group">
      {title || description ? (
        <div className="sp-group-header">
          {title ? <h3>{title}</h3> : null}
          {description ? <p>{description}</p> : null}
        </div>
      ) : null}
      <div className="sp-card">{children}</div>
    </div>
  )
}

export function SettingsRow({
  label,
  description,
  children,
  stacked = false
}: {
  label: ReactNode
  description?: ReactNode
  children?: ReactNode
  /** Put the control under the text, for wide controls such as theme cards. */
  stacked?: boolean
}): React.JSX.Element {
  return (
    <div className={stacked ? 'sp-row is-stacked' : 'sp-row'}>
      <div className="sp-row-text">
        <span className="sp-row-label">{label}</span>
        {description ? <span className="sp-row-description">{description}</span> : null}
      </div>
      {children !== undefined ? <div className="sp-row-control">{children}</div> : null}
    </div>
  )
}

export function Switch({
  checked,
  label,
  disabled,
  onChange
}: {
  checked: boolean
  label: string
  disabled?: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      className="sp-switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden="true" />
    </button>
  )
}

export function Segmented<Value extends string>({
  value,
  options,
  label,
  disabled,
  onChange
}: {
  value: Value
  options: readonly { value: Value; label: string }[]
  label: string
  disabled?: boolean
  onChange: (value: Value) => void
}): React.JSX.Element {
  return (
    <div className="sp-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** A native select for accessibility and keyboard behavior, drawn to match the app. */
export function SelectControl({
  value,
  label,
  disabled,
  onChange,
  children
}: {
  value: string | number
  label: string
  disabled?: boolean
  onChange: (value: string) => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <span className="sp-select">
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
    </span>
  )
}

/** Save state, shown only when there is something to say. */
export function SettingsStatus({
  status,
  error,
  onRetry
}: {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'error'
  error: string | null
  onRetry: () => void
}): React.JSX.Element | null {
  if (status === 'error')
    return (
      <div className="sp-status is-error" role="alert">
        <span>{t('设置读取或保存失败：{error}', { error })}</span>
        <button type="button" onClick={onRetry}>
          {t('重新读取')}
        </button>
      </div>
    )
  return (
    <span className="sp-status" role="status">
      {status === 'saving' ? t('正在保存…') : status === 'loading' ? t('正在读取…') : ''}
    </span>
  )
}
