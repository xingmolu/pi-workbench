import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { AccountSummary } from '../../../shared/contracts'
import type { AccountQuota as Quota } from '../../../shared/account-quota'
import { t } from '../../../shared/i18n'

export default function AccountQuota({
  account,
  authGeneration,
  loginActive,
  runtimeId
}: {
  account: AccountSummary
  authGeneration: number
  loginActive: boolean
  /** Read through this engine's configuration instead of the open chat. */
  runtimeId?: string
}): React.JSX.Element {
  const [quota, setQuota] = useState<Quota | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const epoch = useRef(0)
  useEffect(() => {
    epoch.current++
    setQuota(null)
    setError('')
    setPending(false)
    return () => {
      epoch.current++
    }
  }, [account.id, account.connected, authGeneration, loginActive])
  const refresh = async (): Promise<void> => {
    if (pending || !account.connected || loginActive) return
    const attempt = ++epoch.current
    setPending(true)
    setQuota(null)
    setError('')
    try {
      const command = { type: 'account:quota' as const, providerId: account.id }
      const result = runtimeId
        ? await window.pi.runtimeConfig(runtimeId, command)
        : await window.pi.send(command)
      if (attempt !== epoch.current) return
      if (
        result.quota.providerId !== account.id ||
        result.quota.authGeneration !== authGeneration
      ) {
        setError(t('账号已更新，请重新刷新额度。'))
        return
      }
      setQuota(result.quota)
    } catch {
      if (attempt === epoch.current) setError(t('额度读取失败，请稍后重试。'))
    } finally {
      if (attempt === epoch.current) setPending(false)
    }
  }
  const connected = account.connected && !loginActive
  return (
    <section className="acct-quota" aria-label={t('Codex 订阅额度')}>
      <div className="acct-quota-head">
        <span>
          {t('订阅额度')}
          {quota?.plan ? <em>{quota.plan}</em> : null}
          {quota ? (
            <small>
              {t('读取于 {value}', {
                value: new Date(quota.fetchedAt).toLocaleTimeString('zh-CN')
              })}
            </small>
          ) : null}
        </span>
        <button
          type="button"
          className="acct-button is-quiet"
          disabled={pending || !connected}
          onClick={() => void refresh()}
        >
          <RefreshCw size={13} className={pending ? 'spin' : undefined} />
          {pending ? t('读取中…') : t('刷新额度')}
        </button>
      </div>
      {quota?.state === 'available' ? (
        <div className="acct-quota-windows">
          {quota.windows.map((window, index) => {
            const left = Math.max(0, 100 - window.usedPercent)
            return (
              <div
                className={`acct-quota-window${left <= 10 ? ' is-low' : left <= 30 ? ' is-warn' : ''}`}
                key={index}
              >
                <div className="acct-quota-line">
                  <span>
                    {window.label}
                    {window.windowMinutes
                      ? ` · ${window.windowMinutes >= 1440 ? t('{value} 天', { value: Math.round(window.windowMinutes / 1440) }) : t('{windowMinutes} 分钟', { windowMinutes: window.windowMinutes })}`
                      : ''}
                  </span>
                  <strong>{t('剩余 {value}%', { value: left.toFixed(0) })}</strong>
                </div>
                <meter
                  min={0}
                  max={100}
                  value={100 - window.usedPercent}
                  aria-label={t('{label}剩余额度', { label: window.label })}
                />
                <small>
                  {window.resetsAt != null
                    ? t('{value} 重置', {
                        value: new Date(window.resetsAt * 1000).toLocaleString('zh-CN')
                      })
                    : t('重置时间未知')}
                </small>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="acct-quota-empty" role="status">
          {error ||
            quota?.message ||
            (account.connected
              ? t('点击“刷新额度”查看账号额度；未读取不代表额度为零。')
              : t('登录 Codex 后可读取额度。'))}
        </p>
      )}
      <p className="acct-quota-note">
        {t('来源：Codex 账号服务。额度与会话用量不同；接口不可用时不会估算剩余次数或费用。')}
      </p>
    </section>
  )
}
