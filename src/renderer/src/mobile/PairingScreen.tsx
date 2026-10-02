import { useState } from 'react'
import { MOBILE_SECURITY_COPY } from '../../../shared/mobile-gateway'
import { pairWithCode } from './api'
import { ThemeButton } from './ThemeButton'
import type { useMobileTheme } from './theme'
import { t } from '../../../shared/i18n'

/**
 * First visit without a device token. Scanning the desktop's QR pairs automatically; the code
 * field covers an app added to the home screen, which starts without the browser's storage.
 */
export function PairingScreen({
  theme,
  error,
  onError
}: {
  theme: ReturnType<typeof useMobileTheme>
  error: string
  onError: (message: string) => void
}): React.JSX.Element {
  const [code, setCode] = useState('')
  const [pairing, setPairing] = useState(false)
  return (
    <div className="m-auth">
      <header className="m-top">
        <h1>{t('Pi 远程对话')}</h1>
        <ThemeButton choice={theme.choice} onChoice={theme.setChoice} />
      </header>
      <div className="m-notice">
        <p>{MOBILE_SECURITY_COPY}</p>
      </div>
      <form
        className="m-pair"
        onSubmit={(event) => {
          event.preventDefault()
          if (!code.trim() || pairing) return
          setPairing(true)
          void pairWithCode(code)
            .then(() => onError(''))
            .catch((reason: unknown) =>
              onError(reason instanceof Error ? reason.message : t('配对失败'))
            )
            .finally(() => setPairing(false))
        }}
      >
        <p>{t('在桌面「设置 › 手机」中显示配对码，用这台设备扫描二维码，或输入 8 位配对码：')}</p>
        <input
          aria-label={t('配对码')}
          placeholder="ABCD2345"
          autoCapitalize="characters"
          autoComplete="one-time-code"
          spellCheck={false}
          maxLength={12}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <button type="submit" className="m-button is-primary" disabled={!code.trim() || pairing}>
          {pairing ? t('正在配对…') : t('配对')}
        </button>
      </form>
      {error ? (
        <p className="m-notice is-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
