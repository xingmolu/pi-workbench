import { useEffect, useState } from 'react'
import { KeyRound, LoaderCircle } from 'lucide-react'
import type {
  CredentialGrantDecision,
  CredentialGrantPrompt
} from '../../../shared/engine-credentials'
import { useOverlayState } from '../store/overlay-state'
import { t } from '../../../shared/i18n'

/**
 * "May Codex use robin@example.com?" — asked the first time an engine wants one of the
 * ChatGPT logins Pi holds. Prompts queue; the oldest is shown first.
 */
export default function CredentialGrantDialog(): React.JSX.Element | null {
  const [prompts, setPrompts] = useState<CredentialGrantPrompt[]>([])
  const [pending, setPending] = useState<CredentialGrantDecision | null>(null)
  useEffect(
    () =>
      window.pi.onEvent((event) => {
        if (event.event === 'credential-grant')
          setPrompts((list) =>
            list.some((item) => item.id === event.data.id) ? list : [...list, event.data]
          )
        if (event.event === 'credential-grant-closed')
          setPrompts((list) => list.filter((item) => item.id !== event.data.id))
      }),
    []
  )
  const prompt = prompts[0]
  useEffect(() => {
    if (!prompt) return
    setPending(null)
    const opened = useOverlayState.getState().open('credential-grant')
    return () => {
      if (opened) useOverlayState.getState().close('credential-grant')
    }
  }, [prompt])
  if (!prompt) return null

  const respond = (decision: CredentialGrantDecision): void => {
    if (pending) return
    setPending(decision)
    void window.pi
      .respondCredentialGrant(prompt.id, decision)
      .then(() => setPrompts((list) => list.filter((item) => item.id !== prompt.id)))
      .catch(() => setPending(null))
  }
  const who = prompt.email ?? t('ChatGPT 账号')
  return (
    <div className="plugin-approval-scrim">
      <section
        className="plugin-approval credential-grant"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`credential-grant-${prompt.id}`}
      >
        <header>
          <KeyRound size={15} aria-hidden="true" />
          <span>
            {prompt.runtimeLabel} {t('请求使用账号')}
          </span>
        </header>
        <h3 id={`credential-grant-${prompt.id}`}>
          {t('允许 {runtimeLabel} 使用 {who}？', { runtimeLabel: prompt.runtimeLabel, who })}
        </h3>
        <p>
          {t(
            '这个 ChatGPT 账号是在 Pi 里登录的。允许后，{runtimeLabel}{value} 只拿到短期访问令牌，刷新令牌仍只由 Pi 保存。可以在「设置 › 引擎与账号」随时撤销。',
            { runtimeLabel: prompt.runtimeLabel, value: ' ' }
          )}
        </p>
        <footer>
          <button
            type="button"
            className="secondary-button"
            disabled={pending !== null}
            onClick={() => respond('deny')}
          >
            {pending === 'deny' ? <LoaderCircle className="spin" size={13} /> : null}

            {t('不允许')}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={pending !== null}
            onClick={() => respond('once')}
          >
            {pending === 'once' ? <LoaderCircle className="spin" size={13} /> : null}

            {t('仅这次')}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={pending !== null}
            onClick={() => respond('always')}
            autoFocus
          >
            {pending === 'always' ? <LoaderCircle className="spin" size={13} /> : null}

            {t('始终允许')}
          </button>
        </footer>
      </section>
    </div>
  )
}
