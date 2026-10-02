import { useEffect, useState } from 'react'
import { SettingsGroup, SettingsRow } from './SettingsPrimitives'
import '../assets/accounts-settings.css'

/** Settings › 常规: local logs and crash records, exported as a redacted report on request. */
export default function DiagnosticsSettings(): React.JSX.Element {
  const [crashes, setCrashes] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void window.pi
      .diagnostics({ type: 'summary' })
      .then((summary) => live && setCrashes(summary.crashes))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  const exportReport = async (): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      const result = await window.pi.diagnostics({ type: 'export' })
      if ('saved' in result) setMessage(`已保存到 ${result.saved}`)
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsGroup title="诊断">
      <SettingsRow
        label="导出诊断信息"
        description={
          <span role="status" aria-label="诊断状态">
            {message ||
              `${crashes === null ? '' : crashes ? `最近 7 天有 ${crashes} 次进程意外退出。` : '最近 7 天没有进程意外退出。'}报告包含版本、系统、引擎状态和最近的日志，已去掉密钥、令牌和用户目录；只保存在你选的位置，不会自动上传。`}
          </span>
        }
      >
        <button
          type="button"
          className="acct-button"
          disabled={busy}
          onClick={() => void exportReport()}
        >
          导出…
        </button>
        <button
          type="button"
          className="acct-button is-quiet"
          onClick={() =>
            void window.pi
              .diagnostics({ type: 'open-folder' })
              .catch((reason: Error) => setMessage(reason.message))
          }
        >
          日志文件夹
        </button>
      </SettingsRow>
    </SettingsGroup>
  )
}
