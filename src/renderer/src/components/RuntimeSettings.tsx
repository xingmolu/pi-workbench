import { useEffect, useState } from 'react'
import { FolderOpen, Check, LoaderCircle } from 'lucide-react'
import { usePiStore } from '../store/pi-store'
import RuntimePicker from './RuntimePicker'
import { SettingsPage } from './SettingsPrimitives'

export default function RuntimeSettings(): React.JSX.Element {
  const snapshot = usePiStore((state) => state.snapshot)
  const [legacy, setLegacy] = useState<{ location: string; count: number } | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setLegacy(null)
    setResult(null)
    setError(null)
    if (snapshot.runtime?.id === 'pi')
      void window.pi
        .legacyPiHistory()
        .then((value) => {
          if (!cancelled) setLegacy(value)
        })
        .catch(() => {
          if (!cancelled) setError('无法读取旧 Pi 历史目录')
        })
    return () => {
      cancelled = true
    }
  }, [snapshot.runtime?.id])
  return (
    <SettingsPage title="Agent 引擎" description="每个引擎管理自己的模型、登录和会话。">
      <div className="runtime-settings-selection">
        <RuntimePicker />
        <p>切换引擎会新建会话，已有会话保留各自的引擎。</p>
      </div>
      <dl className="runtime-settings-details">
        <div>
          <dt>子 Agent</dt>
          <dd>{snapshot.runtime?.subagents === 'native' ? 'SDK 原生调度' : '桌面独立会话调度'}</dd>
        </div>
        <div>
          <dt>工具集成</dt>
          <dd>{snapshot.runtime?.toolDelivery === 'mcp' ? 'SDK MCP 工具桥接' : '原生工具扩展'}</dd>
        </div>
        <div>
          <dt>配置目录</dt>
          <dd>
            <FolderOpen size={14} />
            <code>{snapshot.agentDir}</code>
          </dd>
        </div>
      </dl>
      {snapshot.runtime?.id === 'pi' && legacy && legacy.count > 0 ? (
        <section className="runtime-history-import">
          <h3>导入旧 Pi 历史</h3>
          <p>发现 {legacy.count} 个历史文件。导入到应用目录后，可在侧栏继续会话。</p>
          <small>原文件保留；登录凭据、扩展和端点不随历史导入。</small>
          <button
            type="button"
            className="secondary-button"
            disabled={importing}
            onClick={() => {
              setImporting(true)
              setError(null)
              void window.pi
                .importPiHistory()
                .then((value) =>
                  setResult(`已导入 ${value.imported} 个，跳过 ${value.skipped} 个已有或无效文件。`)
                )
                .catch((reason) =>
                  setError(reason instanceof Error ? reason.message : String(reason))
                )
                .finally(() => setImporting(false))
            }}
          >
            {importing ? (
              <LoaderCircle size={14} className="spin" />
            ) : result ? (
              <Check size={14} />
            ) : (
              <FolderOpen size={14} />
            )}
            导入历史
          </button>
          {result ? <p role="status">{result}</p> : null}
        </section>
      ) : null}
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </SettingsPage>
  )
}
