import { useNavigationDialog } from './useNavigationDialog'
import { useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

export default function NameDialog({
  title,
  description,
  initialValue,
  allowEmpty = false,
  onSave,
  onClose
}: {
  title: string
  description: string
  initialValue: string
  allowEmpty?: boolean
  onSave: (name: string) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const opener = useNavigationDialog()
  const [value, setValue] = useState(initialValue)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="navigation-overlay" />
        <Dialog.Content
          className="navigation-dialog name-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const target = opener.current?.isConnected
              ? opener.current
              : document.querySelector<HTMLElement>('.sidebar-global-search, .rail-top button')
            target?.focus({ preventScroll: true })
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            input.current?.select()
          }}
          onEscapeKeyDown={(event) => {
            if (saving || composing.current || event.isComposing) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            if (saving) event.preventDefault()
          }}
        >
          <div className="navigation-dialog-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="关闭" disabled={saving}>
              <X size={17} />
            </Dialog.Close>
          </div>
          <Dialog.Description>{description}</Dialog.Description>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (saving || composing.current || (!allowEmpty && !value.trim())) return
              setSaving(true)
              setError(null)
              void onSave(value.trim())
                .then(onClose)
                .catch((error: unknown) => {
                  setError(error instanceof Error ? error.message : String(error))
                  setSaving(false)
                })
            }}
          >
            <label>
              名称
              <input
                ref={input}
                value={value}
                maxLength={80}
                disabled={saving}
                onChange={(event) => setValue(event.target.value)}
                onCompositionStart={() => {
                  composing.current = true
                }}
                onCompositionEnd={() => {
                  composing.current = false
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    (event.nativeEvent.isComposing || event.keyCode === 229)
                  )
                    event.preventDefault()
                }}
              />
            </label>
            {allowEmpty && <small>清空后恢复文件夹名称。</small>}
            {error && (
              <p className="navigation-error" role="alert">
                {error}
              </p>
            )}
            <div className="navigation-dialog-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={saving}
                onClick={onClose}
              >
                取消
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={saving || (!allowEmpty && !value.trim())}
              >
                {saving ? '正在保存…' : '保存'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
