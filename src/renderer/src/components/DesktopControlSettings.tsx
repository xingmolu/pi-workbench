import { useEffect, useRef, useState } from 'react'
import { Monitor, RefreshCw, Settings } from 'lucide-react'
import {
  screenRecordingChipLabel,
  type CaptureSource,
  type DesktopControlPermission
} from '../../../shared/desktop-control'
import '../assets/desktop-control.css'

const SOURCE_TYPE_LABEL = { screen: '屏幕', window: '窗口' } as const

export function DesktopControlPanel({
  permission,
  sources,
  truncated,
  probed,
  message,
  pending,
  error,
  onRefresh,
  onOpenSettings
}: {
  permission: DesktopControlPermission | null
  sources: readonly CaptureSource[]
  truncated: boolean
  probed: boolean
  message: string | null
  pending: 'permission' | 'sources' | 'settings' | null
  error: string | null
  onRefresh: () => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const access = permission?.access ?? 'unsupported'
  const chip = screenRecordingChipLabel(access)
  const loadingPermission = pending === 'permission' && !permission
  return (
    <section className="desktop-control-settings" aria-label="桌面控制">
      <header className="desktop-control-heading">
        <div>
          <h2>
            <Monitor size={18} />
            桌面控制
          </h2>
          <p>Computer Use 屏幕捕获（Spike 1）</p>
        </div>
      </header>
      <p className="desktop-control-guide">
        完整 Computer Use 后续还需要「屏幕录制」和「辅助功能」授权。当前 Spike 1
        只做屏幕与窗口截取探测，不会点击或注入输入。adhoc / 未签名构建可能在每次重建后无法记住 TCC
        授权。
      </p>
      <article className="desktop-control-card">
        <div className="desktop-control-status">
          <span>
            <strong>屏幕录制</strong>
            <small>
              {loadingPermission
                ? '正在读取本机授权状态…'
                : permission?.platformSupported
                  ? '由 macOS TCC 决定；授权后可试截取屏幕与窗口缩略图。'
                  : '当前仅在 macOS 上探测屏幕录制授权。'}
            </small>
          </span>
          <span
            className={`desktop-control-chip is-${access}`}
            data-testid="screen-recording-status"
            data-access={access}
          >
            {loadingPermission ? '读取中' : chip}
          </span>
        </div>
        <div className="desktop-control-actions">
          <button
            className="primary-button"
            type="button"
            disabled={!permission?.canOpenSettings || pending === 'settings'}
            onClick={onOpenSettings}
          >
            <Settings size={14} />
            打开系统设置（屏幕录制）
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={pending === 'sources' || pending === 'permission'}
            onClick={onRefresh}
          >
            <RefreshCw size={14} />
            {pending === 'sources' ? '正在截取…' : '刷新 / 试截取'}
          </button>
        </div>
        {error ? (
          <p className="desktop-control-error" role="alert">
            {error}
          </p>
        ) : null}
      </article>
      {probed && sources.length > 0 ? (
        <ul className="desktop-control-gallery" aria-label="可截取的屏幕和窗口">
          {sources.map((item) => (
            <li className="desktop-control-source" key={item.id}>
              {item.thumbnailDataUrl ? (
                <img alt="" src={item.thumbnailDataUrl} />
              ) : (
                <span className="desktop-control-thumb-empty">无缩略图</span>
              )}
              <strong title={item.name}>{item.name}</strong>
              <small>{SOURCE_TYPE_LABEL[item.type]}</small>
            </li>
          ))}
        </ul>
      ) : probed ? (
        <p className="desktop-control-empty" role="status">
          {message ?? '没有可显示的屏幕或窗口。'}
        </p>
      ) : null}
      {truncated ? <p className="desktop-control-footnote">{message}</p> : null}
    </section>
  )
}

export default function DesktopControlSettings(): React.JSX.Element {
  const [permission, setPermission] = useState<DesktopControlPermission | null>(null)
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [truncated, setTruncated] = useState(false)
  const [probed, setProbed] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState<'permission' | 'sources' | 'settings' | null>('permission')
  const [error, setError] = useState<string | null>(null)
  const epoch = useRef(0)

  const run = async (
    type: 'permission' | 'sources' | 'open-screen-recording-settings'
  ): Promise<void> => {
    const attempt = ++epoch.current
    const pendingKind =
      type === 'permission' ? 'permission' : type === 'sources' ? 'sources' : 'settings'
    setPending(pendingKind)
    setError(null)
    try {
      const result = await window.pi.desktopControl({ type })
      if (attempt !== epoch.current) return
      setPermission(result.permission)
      if (result.type === 'sources') {
        setSources(result.sources)
        setTruncated(result.truncated)
        setProbed(true)
        setMessage(result.message ?? null)
      } else if (result.type === 'open-settings' && !result.opened) {
        setError(result.message ?? '无法打开系统设置。')
      } else if (result.type === 'permission') {
        setMessage(null)
      }
    } catch (caught) {
      if (attempt !== epoch.current) return
      setError(caught instanceof Error ? caught.message : '桌面控制请求失败，请重试。')
    } finally {
      if (attempt === epoch.current) setPending(null)
    }
  }

  useEffect(() => {
    void run('permission')
    const requests = epoch
    return () => {
      requests.current++
    }
  }, [])

  return (
    <DesktopControlPanel
      permission={permission}
      sources={sources}
      truncated={truncated}
      probed={probed}
      message={message}
      pending={pending}
      error={error}
      onRefresh={() => void run('sources')}
      onOpenSettings={() => void run('open-screen-recording-settings')}
    />
  )
}
