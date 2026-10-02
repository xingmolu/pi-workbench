import { useEffect, useState } from 'react'
import { LoaderCircle, Puzzle } from 'lucide-react'
import type { WorkbenchEvent } from '../../../shared/workbench-contracts'
import { useOverlayState } from '../store/overlay-state'
import { t } from '../../../shared/i18n'

export type PluginApproval = Extract<WorkbenchEvent, { type: 'plugin-approval' }>

/** One plugin write request at a time, above native plugin views (which the overlay hides). */
export default function PluginApprovalDialog({
  approval,
  onRespond
}: {
  approval: PluginApproval
  onRespond: (id: string, allow: boolean) => Promise<void>
}): React.JSX.Element {
  const [pending, setPending] = useState<'allow' | 'deny' | null>(null)
  useEffect(() => {
    const opened = useOverlayState.getState().open('plugin-approval')
    return () => {
      if (opened) useOverlayState.getState().close('plugin-approval')
    }
  }, [approval.id])

  const respond = (allow: boolean): void => {
    if (pending) return
    setPending(allow ? 'allow' : 'deny')
    void onRespond(approval.id, allow).catch(() => setPending(null))
  }

  return (
    <div className="plugin-approval-scrim">
      <section
        className="plugin-approval"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`plugin-approval-${approval.id}`}
      >
        <header>
          <Puzzle size={15} aria-hidden="true" />
          <span>{t('插件 {pluginName} 请求', { pluginName: approval.pluginName })}</span>
        </header>
        <h3 id={`plugin-approval-${approval.id}`}>{approval.title}</h3>
        {approval.detail ? <pre>{approval.detail}</pre> : null}
        <p>{t('这是插件发起的操作，不是 Pi 的对话。允许仅对这一次生效。')}</p>
        <footer>
          <button
            type="button"
            className="secondary-button"
            disabled={pending !== null}
            onClick={() => respond(false)}
          >
            {pending === 'deny' ? <LoaderCircle className="spin" size={13} /> : null}

            {t('拒绝')}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={pending !== null}
            onClick={() => respond(true)}
            autoFocus
          >
            {pending === 'allow' ? <LoaderCircle className="spin" size={13} /> : null}

            {t('允许一次')}
          </button>
        </footer>
      </section>
    </div>
  )
}
