import { useEffect, useId, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { GitFork } from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import { commandOrigin, usePiStore } from '../store/pi-store'
import { sameSelectedScope } from '../../../shared/session-runtime'
import { t } from '../../../shared/i18n'

export default function SessionFork({
  snapshot,
  entryId,
  messageAction = false
}: {
  snapshot: AgentSnapshot
  entryId?: string
  messageAction?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const hintId = useId()
  const pending = usePiStore((state) => state.forkPending)
  const scope = JSON.stringify([
    snapshot.sessionId,
    snapshot.generation,
    snapshot.desktopScope ?? null
  ])
  const reason = !snapshot.ready
    ? t('请先连接引擎')
    : (snapshot.fork?.reason ??
      (messageAction && !entryId
        ? t('回复尚未完成，暂时不能分叉')
        : !snapshot.fork?.entryId
          ? t('当前会话暂时不能分叉')
          : null))
  const enabled = !reason && !pending && Boolean(snapshot.sessionId)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const fork = async () => {
    if (!enabled || error || inFlight.current || usePiStore.getState().forkPending) return
    inFlight.current = true
    usePiStore.getState().setForkPending(scope)
    setError(null)
    setCancelled(false)
    try {
      const result = await window.pi.send(
        {
          type: 'session:fork',
          sessionId: snapshot.sessionId!,
          generation: snapshot.generation,
          entryId: messageAction ? entryId! : snapshot.fork!.entryId!
        },
        commandOrigin(snapshot)
      )
      if (
        !sameSelectedScope(
          snapshot.desktopScope ?? null,
          usePiStore.getState().snapshot.desktopScope ?? null
        )
      )
        return
      if (
        !result.cancelled &&
        (result.snapshot.sessionId === snapshot.sessionId ||
          result.snapshot.generation <= snapshot.generation)
      )
        throw new Error(t('分叉结果无法确认，请核对当前会话和列表，不要直接重试。'))
      usePiStore.getState().setSnapshot(result.snapshot)
      if (mounted.current) {
        if (result.cancelled) setCancelled(true)
        else setOpen(false)
      }
    } catch (cause) {
      const current = usePiStore.getState().snapshot
      if (
        current.sessionId !== snapshot.sessionId ||
        current.generation !== snapshot.generation ||
        !sameSelectedScope(snapshot.desktopScope ?? null, current.desktopScope ?? null)
      )
        return
      const message = (cause instanceof Error ? cause.message : String(cause)).replace(
        /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
        ''
      )
      if (mounted.current) setError(message)
      else usePiStore.getState().setClientError(message)
    } finally {
      inFlight.current = false
      if (usePiStore.getState().forkPending === scope) usePiStore.getState().setForkPending(null)
    }
  }
  return (
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        if (!inFlight.current) {
          setOpen(value)
          setError(null)
          setCancelled(false)
        }
      }}
    >
      <Popover.Trigger
        className={messageAction ? 'message-action-icon' : 'session-action'}
        aria-label={messageAction ? t('从此回复分叉') : t('分叉为新会话')}
        aria-disabled={!enabled}
        title={reason ?? t('分叉为新会话')}
        onClick={(event) => {
          if (!enabled) event.preventDefault()
        }}
        aria-describedby={reason || messageAction ? hintId : undefined}
      >
        <GitFork size={messageAction ? 16 : 13} />
        {messageAction ? (
          <span id={hintId} className="message-action-tooltip" role="tooltip">
            {reason ?? t('从此回复分叉')}
          </span>
        ) : (
          <span>{t('分叉为新会话')}</span>
        )}
      </Popover.Trigger>
      {reason && !messageAction ? (
        <span className="sr-only" id={hintId}>
          {reason}
        </span>
      ) : null}
      <Popover.Portal>
        <Popover.Content
          className="session-popover"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label={t('分叉当前会话')}
        >
          <p>
            {messageAction ? t('复制截至此回复的历史到新会话') : t('复制当前历史到新会话')}
            {t('；不复制未发送草稿，不撤销文件或终端操作。')}
          </p>
          {error ? (
            <p role="alert" className="session-rename-error">
              {error}
            </p>
          ) : null}
          {cancelled ? <p role="status">{t('扩展已取消分叉，当前会话和草稿保留。')}</p> : null}
          <div className="session-form-actions">
            <Popover.Close className="secondary-button" disabled={Boolean(pending)}>
              {error ? t('关闭并核对') : t('取消')}
            </Popover.Close>
            <button
              className="primary-button"
              disabled={!enabled || Boolean(error)}
              onClick={() => void fork()}
            >
              {pending ? t('正在分叉…') : t('确认分叉')}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
