import { useEffect, useId, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Pencil } from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import { normalizeSessionName } from '../../../shared/session-name'

export default function SessionActions({
  snapshot,
  title
}: {
  snapshot: AgentSnapshot
  title: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(title)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const inputId = useId()
  const enabled = Boolean(
    snapshot.ready && snapshot.sessionId && snapshot.activeSessionPath && !snapshot.busy
  )
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const save = async (): Promise<void> => {
    if (!enabled || inFlight.current) return
    let normalized: string
    try {
      normalized = normalizeSessionName(name)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return
    }
    inFlight.current = true
    setPending(true)
    setError(null)
    try {
      await window.pi.send({
        type: 'session:rename',
        sessionId: snapshot.sessionId!,
        generation: snapshot.generation,
        name: normalized
      })
      if (mounted.current) setOpen(false)
    } catch (cause) {
      if (mounted.current)
        setError(
          (cause instanceof Error ? cause.message : String(cause)).replace(
            /^Error invoking remote method '[^']+': (?:Error: )?/,
            ''
          )
        )
    } finally {
      inFlight.current = false
      if (mounted.current) setPending(false)
    }
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (pending) return
        if (next) {
          setName(title)
          setError(null)
        }
        setOpen(next)
      }}
    >
      <Popover.Trigger
        className="session-action"
        disabled={!enabled}
        aria-label="重命名会话"
        title="重命名会话"
      >
        <Pencil size={13} />
        <span>重命名会话</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="session-popover"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label="重命名会话"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <label htmlFor={inputId}>会话名称</label>
            <input
              id={inputId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={pending}
              aria-describedby={`${inputId}-hint${error ? ` ${inputId}-error` : ''}`}
              aria-invalid={Boolean(error)}
            />
            <p id={`${inputId}-hint`} className="session-name-hint">
              最多 80 个字符
            </p>
            {error ? (
              <p id={`${inputId}-error`} className="session-rename-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="session-form-actions">
              <Popover.Close className="secondary-button" disabled={pending}>
                取消
              </Popover.Close>
              <button className="primary-button" type="submit" disabled={pending || !enabled}>
                {pending ? '正在保存…' : '保存名称'}
              </button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
