import { useEffect, useState } from 'react'
import { Check, CircleAlert, Clipboard, LoaderCircle } from 'lucide-react'
import type { LoginPrompt, LoginStatus } from '../../../shared/contracts'
import { t } from '../../../shared/i18n'

/** Progress of a sign-in, next to the account it is for. */
export function LoginState({ login }: { login: LoginStatus }): React.JSX.Element | null {
  if (login.phase === 'idle') return null
  if (login.phase === 'error') {
    return (
      <div className="login-state is-error">
        <CircleAlert size={15} />
        <span>{login.message}</span>
      </div>
    )
  }
  if (login.phase === 'success') {
    return (
      <div className="login-state is-success">
        <Check size={15} />
        <span>{t('登录成功，凭证已刷新。')}</span>
      </div>
    )
  }
  if (login.phase === 'device_code') {
    return (
      <div className="device-code-card">
        <span>{t('在浏览器中输入设备码')}</span>
        <div>
          <code>{login.userCode}</code>
          <button
            type="button"
            className="icon-btn"
            title={t('复制设备码')}
            aria-label={t('复制设备码')}
            onClick={() => void navigator.clipboard.writeText(login.userCode)}
          >
            <Clipboard size={14} />
          </button>
        </div>
        <small>{login.verificationUri}</small>
      </div>
    )
  }
  return (
    <div className="login-state">
      <LoaderCircle className="spin" size={15} />
      <span>
        {login.phase === 'starting'
          ? t('正在启动登录…')
          : login.phase === 'browser'
            ? login.instructions || t('已在系统浏览器打开登录页。')
            : login.message}
      </span>
    </div>
  )
}

export function AuthPromptCard({
  prompt,
  onRespond
}: {
  prompt: LoginPrompt
  onRespond: (promptId: string, value?: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  useEffect(() => setValue(''), [prompt.id])

  if (prompt.type === 'select') {
    return (
      <div className="auth-prompt-card">
        <strong>{prompt.message}</strong>
        <div className="prompt-options">
          {prompt.options?.map((option) => (
            <button
              key={option.id}
              type="button"
              className="secondary-button prompt-option"
              onClick={() => onRespond(prompt.id, option.id)}
            >
              <span>{option.label}</span>
              {option.description ? <small>{option.description}</small> : null}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <form
      className="auth-prompt-card"
      onSubmit={(event) => {
        event.preventDefault()
        onRespond(prompt.id, value)
      }}
    >
      <label htmlFor={`auth-${prompt.id}`}>{prompt.message}</label>
      <input
        id={`auth-${prompt.id}`}
        type={prompt.type === 'secret' ? 'password' : 'text'}
        value={value}
        autoFocus
        placeholder={prompt.placeholder}
        onChange={(event) => setValue(event.target.value)}
      />
      <button className="primary-button" type="submit" disabled={!value.trim()}>
        {t('继续')}
      </button>
    </form>
  )
}
