import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { AppUpdateCommand, AppUpdateStatus } from '../../../shared/app-updates'
import { SettingsGroup, SettingsRow } from './SettingsPrimitives'
import '../assets/accounts-settings.css'

function describe(status: AppUpdateStatus): string {
  switch (status.state) {
    case 'checking':
      return '正在检查…'
    case 'none':
      return '已是最新版本'
    case 'available':
      return status.install === 'auto'
        ? `发现新版本 ${status.next}`
        : `发现新版本 ${status.next}，在发布页下载后替换当前应用`
    case 'downloading':
      return `正在下载 ${status.next}（${status.percent}%）`
    case 'ready':
      return `${status.next} 已下载，重启后生效`
    case 'needs-token':
    case 'error':
    case 'unsupported':
      return status.message
    default:
      return status.checkedAt ? '' : '尚未检查'
  }
}

/** Settings › 常规: which build this is, and whether a newer one is out. */
export default function AppUpdateSettings(): React.JSX.Element | null {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    void window.pi
      .appUpdate({ type: 'status' })
      .then((value) => live && setStatus(value))
      .catch(() => undefined)
    const stop = window.pi.onAppUpdate((value) => setStatus(value))
    return () => {
      live = false
      stop()
    }
  }, [])

  if (!status) return null
  const run = async (command: AppUpdateCommand): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setStatus(await window.pi.appUpdate(command))
      if (command.type === 'token:set') setToken('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  const working = busy || status.state === 'checking' || status.state === 'downloading'
  return (
    <SettingsGroup title="版本与更新">
      <SettingsRow
        label={`Pi Desktop ${status.version}`}
        description={
          <span role="status" aria-label="更新状态">
            {[status.channel === 'nightly' ? '测试版通道' : '正式版通道', describe(status)]
              .filter(Boolean)
              .join(' · ')}
          </span>
        }
      >
        {status.state === 'ready' ? (
          <button
            type="button"
            className="acct-button is-primary"
            onClick={() => void run({ type: 'install' })}
          >
            重启并更新
          </button>
        ) : status.state === 'available' ? (
          <button
            type="button"
            className="acct-button is-primary"
            disabled={working}
            onClick={() => void run({ type: 'download' })}
          >
            {status.install === 'auto' ? '下载更新' : '打开下载页'}
          </button>
        ) : status.state !== 'unsupported' ? (
          <button
            type="button"
            className="acct-button"
            disabled={working}
            onClick={() => void run({ type: 'check' })}
          >
            {working ? <LoaderCircle size={14} className="spin" /> : null}
            检查更新
          </button>
        ) : null}
      </SettingsRow>
      {status.state === 'needs-token' || status.hasToken ? (
        <SettingsRow
          label="GitHub 令牌"
          description="仓库是私有的，检查更新需要一个只读令牌（Fine-grained，Contents: Read-only）。令牌加密保存在本机，只用于读取发布页。"
        >
          {status.hasToken ? (
            <button
              type="button"
              className="acct-button is-quiet"
              disabled={busy}
              onClick={() => void run({ type: 'token:clear' })}
            >
              移除令牌
            </button>
          ) : (
            <form
              className="sp-inline-form"
              onSubmit={(event) => {
                event.preventDefault()
                void run({ type: 'token:set', token })
              }}
            >
              <input
                type="password"
                aria-label="GitHub 令牌"
                placeholder="github_pat_…"
                value={token}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setToken(event.target.value)}
              />
              <button type="submit" className="acct-button" disabled={busy || !token.trim()}>
                保存
              </button>
            </form>
          )}
        </SettingsRow>
      ) : null}
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </SettingsGroup>
  )
}
