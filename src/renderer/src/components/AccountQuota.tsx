import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { AccountSummary } from '../../../shared/contracts'
import type { AccountQuota as Quota } from '../../../shared/account-quota'

export default function AccountQuota({
  account,
  authGeneration,
  loginActive
}: {
  account: AccountSummary
  authGeneration: number
  loginActive: boolean
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
  const refresh = async () => {
    if (pending || !account.connected || loginActive) return
    const attempt = ++epoch.current
    setPending(true)
    setQuota(null)
    setError('')
    try {
      const result = await window.pi.send({ type: 'account:quota', providerId: account.id })
      if (attempt !== epoch.current) return
      if (
        result.quota.providerId !== account.id ||
        result.quota.authGeneration !== authGeneration
      ) {
        setError('账号已更新，请重新刷新额度。')
        return
      }
      setQuota(result.quota)
    } catch {
      if (attempt === epoch.current) setError('额度读取失败，请稍后重试。')
    } finally {
      if (attempt === epoch.current) setPending(false)
    }
  }
  return (
    <section className="account-quota" aria-label="Codex 订阅额度">
      <div className="settings-section-title">
        <strong>订阅额度{quota?.plan ? ` · ${quota.plan}` : ''}</strong>
        <button
          type="button"
          className="secondary-button"
          disabled={pending || !account.connected || loginActive}
          onClick={() => void refresh()}
        >
          <RefreshCw size={13} />
          {pending ? '读取中…' : '刷新额度'}
        </button>
      </div>
      {quota?.state === 'available' ? (
        quota.windows.map((window, index) => (
          <div className="quota-window" key={index}>
            <div>
              <span>
                {window.label}
                {window.windowMinutes
                  ? ` · ${window.windowMinutes >= 1440 ? `${Math.round(window.windowMinutes / 1440)} 天` : `${window.windowMinutes} 分钟`}`
                  : ''}
              </span>
              <strong>剩余 {Math.max(0, 100 - window.usedPercent).toFixed(0)}%</strong>
            </div>
            <meter
              min={0}
              max={100}
              value={100 - window.usedPercent}
              aria-label={`${window.label}剩余额度`}
            />
            <small>
              {window.resetsAt != null
                ? `${new Date(window.resetsAt * 1000).toLocaleString('zh-CN')} 重置`
                : '重置时间未知'}
            </small>
          </div>
        ))
      ) : (
        <p role="status">
          {error ||
            quota?.message ||
            (account.connected
              ? '点击刷新查看账号额度；未读取不代表额度为零。'
              : '登录 Codex 后可读取额度。')}
        </p>
      )}
      {quota && <small>读取于 {new Date(quota.fetchedAt).toLocaleTimeString('zh-CN')}</small>}
      <p className="inline-hint">
        来源：Codex 账号服务。额度与会话用量不同；接口不可用时不会估算剩余次数或费用。
      </p>
    </section>
  )
}
