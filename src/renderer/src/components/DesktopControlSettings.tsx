import { useEffect, useRef, useState } from 'react'
import { ListTree, MousePointerClick, Monitor, RefreshCw, Settings } from 'lucide-react'
import {
  screenRecordingChipLabel,
  type AxDump,
  type AxHitTarget,
  type AxNode,
  type CaptureSource,
  type DesktopControlPermission
} from '../../../shared/desktop-control'
import { usePiStore } from '../store/pi-store'
import '../assets/desktop-control.css'

const SOURCE_TYPE_LABEL = { screen: '屏幕', window: '窗口' } as const

type PendingKind =
  'permission' | 'sources' | 'settings' | 'accessibility' | 'dump' | 'preview' | 'click' | null

function AxTree({ node }: { node: AxNode }): React.JSX.Element {
  return (
    <li>
      <span>
        {node.role || 'element'}
        {node.title ? ` · ${node.title}` : ''}
        {node.x !== null && node.y !== null ? ` (${node.x},${node.y})` : ''}
      </span>
      {node.children.length > 0 ? (
        <ul>
          {node.children.map((child, index) => (
            <AxTree key={`${child.role}-${index}`} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function PermissionChip({
  label,
  permission,
  testId,
  loading,
  probeFailed,
  supportedHint,
  unsupportedHint
}: {
  label: string
  permission: DesktopControlPermission | null
  testId: string
  loading: boolean
  probeFailed: boolean
  supportedHint: string
  unsupportedHint: string
}): React.JSX.Element {
  const access = permission?.access ?? 'pending'
  return (
    <div className="desktop-control-status">
      <span>
        <strong>{label}</strong>
        <small>
          {loading
            ? '正在读取本机授权状态…'
            : permission === null
              ? '尚无本机检测结果；可点击“重新检测权限”。'
              : permission.platformSupported
                ? supportedHint
                : unsupportedHint}
        </small>
      </span>
      <span
        className={`desktop-control-chip is-${access}`}
        data-testid={testId}
        data-access={access}
      >
        {loading
          ? '检测中'
          : probeFailed
            ? '检测失败'
            : permission
              ? screenRecordingChipLabel(access)
              : '待检测'}
      </span>
    </div>
  )
}

export function DesktopControlPanel({
  permission,
  accessibility,
  screenProbeFailed,
  accessibilityProbeFailed,
  activeModel,
  sources,
  truncated,
  probed,
  message,
  dump,
  dumpProbed,
  dumpMessage,
  sessionUnlocked,
  previewTarget,
  previewAllowed,
  previewMessage,
  pending,
  error,
  onRefresh,
  onOpenSettings,
  onOpenAccessibilitySettings,
  onDump,
  onPreview,
  onConfirmClick
}: {
  permission: DesktopControlPermission | null
  accessibility: DesktopControlPermission | null
  screenProbeFailed: boolean
  accessibilityProbeFailed: boolean
  activeModel: { name: string; acceptsImages: boolean } | null
  sources: readonly CaptureSource[]
  truncated: boolean
  probed: boolean
  message: string | null
  dump: AxDump | null
  dumpProbed: boolean
  dumpMessage: string | null
  sessionUnlocked: boolean | null
  previewTarget: AxHitTarget | null
  previewAllowed: boolean
  previewMessage: string | null
  pending: PendingKind
  error: string | null
  onRefresh: () => void
  onOpenSettings: () => void
  onOpenAccessibilitySettings: () => void
  onDump: () => void
  onPreview: (x: number, y: number) => void
  onConfirmClick: (x: number, y: number) => void
}): React.JSX.Element {
  const [x, setX] = useState('0')
  const [y, setY] = useState('0')
  const loadingStatus = permission === null && (pending === 'permission' || pending === 'sources')
  const loadingAccessibility =
    accessibility === null && (pending === 'accessibility' || pending === 'sources')
  return (
    <section className="desktop-control-settings" aria-label="桌面控制">
      <header className="desktop-control-heading">
        <div>
          <h2>
            <Monitor size={18} />
            桌面控制
          </h2>
          <p>Computer Use：屏幕捕获、辅助功能与确认后输入</p>
        </div>
      </header>
      <p className="desktop-control-guide">
        辅助功能用于读取窗口和操作控件；Computer Use
        截图只包含当前前台窗口，切换窗口后需重新观察。点击和输入仍需逐次确认。
        授权新安装包后，请完全退出（Cmd+Q）并重开 Pi Desktop，再点击“重新检测权限”。
      </p>
      {activeModel ? (
        <p className="desktop-control-guide" data-testid="computer-use-model-capability">
          当前模型 {activeModel.name}：
          {activeModel.acceptsImages
            ? '已配置图像输入；截图仍需屏幕录制授权。'
            : '未声明图像输入能力；Computer Use 只能使用辅助功能读取界面，不能看截图。'}
        </p>
      ) : null}
      <article className="desktop-control-card">
        <PermissionChip
          label="屏幕录制"
          permission={permission}
          testId="screen-recording-status"
          loading={loadingStatus}
          probeFailed={screenProbeFailed}
          supportedHint="由截取探测与 macOS TCC 共同确认；授权后可试截取屏幕与窗口缩略图。"
          unsupportedHint="当前仅在 macOS 上探测屏幕录制授权。"
        />
        <PermissionChip
          label="辅助功能"
          permission={accessibility}
          testId="accessibility-status"
          loading={loadingAccessibility}
          probeFailed={accessibilityProbeFailed}
          supportedHint="由辅助功能树探测与 macOS TCC 共同确认；授权后可读取前台窗口结构。"
          unsupportedHint="当前仅在 macOS 上探测辅助功能授权。"
        />
        {sessionUnlocked === false ? (
          <p className="desktop-control-error" role="status">
            当前会话已锁定，拒绝桌面输入。
          </p>
        ) : null}
        <div className="desktop-control-actions">
          <button
            className="primary-button"
            type="button"
            disabled={permission?.canOpenSettings === false || pending === 'settings'}
            onClick={onOpenSettings}
          >
            <Settings size={14} />
            打开系统设置（屏幕录制）
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={accessibility?.canOpenSettings === false || pending === 'settings'}
            onClick={onOpenAccessibilitySettings}
          >
            <Settings size={14} />
            打开系统设置（辅助功能）
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={pending === 'sources' || pending === 'permission'}
            onClick={onRefresh}
          >
            <RefreshCw size={14} />
            {pending === 'sources' ? '正在检测…' : '重新检测权限'}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={pending === 'dump'}
            onClick={onDump}
          >
            <ListTree size={14} />
            {pending === 'dump' ? '正在读取结构…' : '读取窗口结构'}
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
      {dumpProbed ? (
        <article className="desktop-control-card desktop-control-dump" data-testid="ax-dump">
          <h3>辅助功能树（有界）</h3>
          {dump ? (
            <>
              <p>
                {dump.app || '前台应用'}
                {dump.bundleId ? ` · ${dump.bundleId}` : ''} · {dump.nodeCount} 个节点
                {dump.truncated ? ' · 已截断' : ''}
              </p>
              <ul className="desktop-control-ax-tree" aria-label="辅助功能树">
                {dump.windows.map((windowNode, index) => (
                  <AxTree key={`${windowNode.role}-${index}`} node={windowNode} />
                ))}
              </ul>
            </>
          ) : (
            <p className="desktop-control-empty" role="status">
              {dumpMessage ?? '没有可显示的窗口结构。'}
            </p>
          )}
        </article>
      ) : null}
      <article className="desktop-control-card">
        <h3>
          <MousePointerClick size={16} />
          坐标点击（需确认）
        </h3>
        <p className="desktop-control-guide">
          仅用于本机干跑。先预览命中节点，再确认发送一次点击。Agent 路径仍会
          Ask，不会走这条设置按钮。
        </p>
        <div className="desktop-control-point">
          <label>
            X
            <input
              aria-label="点击坐标 X"
              inputMode="numeric"
              value={x}
              onChange={(event) => setX(event.target.value)}
            />
          </label>
          <label>
            Y
            <input
              aria-label="点击坐标 Y"
              inputMode="numeric"
              value={y}
              onChange={(event) => setY(event.target.value)}
            />
          </label>
          <button
            className="secondary-button"
            type="button"
            disabled={pending === 'preview'}
            onClick={() => onPreview(Number.parseInt(x, 10) || 0, Number.parseInt(y, 10) || 0)}
          >
            {pending === 'preview' ? '正在预览…' : '预览命中'}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={!previewAllowed || pending === 'click'}
            onClick={() => onConfirmClick(Number.parseInt(x, 10) || 0, Number.parseInt(y, 10) || 0)}
          >
            {pending === 'click' ? '正在点击…' : '确认点击'}
          </button>
        </div>
        {previewTarget ? (
          <p data-testid="ax-hit-target">
            命中 {previewTarget.role}
            {previewTarget.title ? ` · ${previewTarget.title}` : ''}
          </p>
        ) : previewMessage ? (
          <p className="desktop-control-empty" role="status">
            {previewMessage}
          </p>
        ) : null}
      </article>
    </section>
  )
}

export default function DesktopControlSettings(): React.JSX.Element {
  const activeModel = usePiStore((state) => {
    const snapshot = state.snapshot
    return snapshot.models.find(
      (item) => item.provider === snapshot.activeProvider && item.id === snapshot.activeModel
    )
  })
  const [permission, setPermission] = useState<DesktopControlPermission | null>(null)
  const [accessibility, setAccessibility] = useState<DesktopControlPermission | null>(null)
  const [screenProbeFailed, setScreenProbeFailed] = useState(false)
  const [accessibilityProbeFailed, setAccessibilityProbeFailed] = useState(false)
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [truncated, setTruncated] = useState(false)
  const [probed, setProbed] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [dump, setDump] = useState<AxDump | null>(null)
  const [dumpProbed, setDumpProbed] = useState(false)
  const [dumpMessage, setDumpMessage] = useState<string | null>(null)
  const [sessionUnlocked, setSessionUnlocked] = useState<boolean | null>(null)
  const [previewTarget, setPreviewTarget] = useState<AxHitTarget | null>(null)
  const [previewAllowed, setPreviewAllowed] = useState(false)
  const [previewMessage, setPreviewMessage] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingKind>('sources')
  const [error, setError] = useState<string | null>(null)
  const epoch = useRef(0)

  const applyScreen = (next: DesktopControlPermission): void => {
    setPermission(next)
  }

  const runSources = async (): Promise<void> => {
    const attempt = ++epoch.current
    setPending('sources')
    setError(null)
    setPermission(null)
    setAccessibility(null)
    setScreenProbeFailed(false)
    setAccessibilityProbeFailed(false)
    setSources([])
    setTruncated(false)
    setProbed(false)
    setMessage(null)
    setDump(null)
    setDumpProbed(false)
    setDumpMessage(null)
    setPreviewTarget(null)
    setPreviewAllowed(false)
    setPreviewMessage(null)
    try {
      const [screen, ax] = await Promise.allSettled([
        window.pi.desktopControl({ type: 'sources' }),
        window.pi.desktopControl({ type: 'accessibility-permission' })
      ])
      if (attempt !== epoch.current) return
      const screenReady = screen.status === 'fulfilled' && screen.value.type === 'sources'
      const accessibilityReady =
        ax.status === 'fulfilled' && ax.value.type === 'accessibility-permission'
      if (screen.status === 'fulfilled' && screen.value.type === 'sources') {
        applyScreen(screen.value.permission)
        setSources(screen.value.sources)
        setTruncated(screen.value.truncated)
        setProbed(true)
        setMessage(screen.value.message ?? null)
      } else {
        setScreenProbeFailed(true)
        setSources([])
        setProbed(false)
      }
      if (ax.status === 'fulfilled' && ax.value.type === 'accessibility-permission') {
        setAccessibility(ax.value.permission)
      } else setAccessibilityProbeFailed(true)
      if (!screenReady || !accessibilityReady) {
        const failures = [
          !screenReady ? '屏幕录制' : null,
          !accessibilityReady ? '辅助功能' : null
        ].filter(Boolean)
        setError(`${failures.join('和')}检测失败。请重新检测；仍失败时检查当前安装包与系统授权。`)
      }
    } catch (caught) {
      if (attempt !== epoch.current) return
      setError(caught instanceof Error ? caught.message : '桌面控制请求失败，请重试。')
    } finally {
      if (attempt === epoch.current) setPending(null)
    }
  }

  const run = async (
    command:
      | { type: 'open-screen-recording-settings' }
      | { type: 'open-accessibility-settings' }
      | { type: 'accessibility-dump' }
      | { type: 'input-preview'; x: number; y: number }
      | { type: 'input-click'; x: number; y: number; confirmed: true }
  ): Promise<void> => {
    const attempt = ++epoch.current
    const pendingKind: PendingKind =
      command.type === 'accessibility-dump'
        ? 'dump'
        : command.type === 'input-preview'
          ? 'preview'
          : command.type === 'input-click'
            ? 'click'
            : 'settings'
    setPending(pendingKind)
    setError(null)
    try {
      const result = await window.pi.desktopControl(command)
      if (attempt !== epoch.current) return
      if (result.type === 'open-settings') {
        if (command.type === 'open-accessibility-settings') setAccessibility(result.permission)
        else applyScreen(result.permission)
        if (!result.opened) setError(result.message ?? '无法打开系统设置。')
      } else if (result.type === 'accessibility-dump') {
        setAccessibility(result.permission)
        setDump(result.dump)
        setDumpProbed(true)
        setDumpMessage(result.message ?? null)
        setSessionUnlocked(result.sessionUnlocked)
      } else if (result.type === 'input-preview') {
        applyScreen(result.screen)
        setAccessibility(result.accessibility)
        setSessionUnlocked(result.sessionUnlocked)
        setPreviewTarget(result.target)
        setPreviewAllowed(result.allowed)
        setPreviewMessage(result.message ?? (result.target ? null : '该坐标没有命中可识别节点。'))
      } else if (result.type === 'input-click') {
        applyScreen(result.screen)
        setAccessibility(result.accessibility)
        setSessionUnlocked(result.sessionUnlocked)
        setPreviewTarget(result.target)
        setPreviewAllowed(false)
        if (!result.executed) setError(result.message ?? '未能发送点击。')
        else setPreviewMessage(result.message ?? '已发送点击。')
      }
    } catch (caught) {
      if (attempt !== epoch.current) return
      setError(caught instanceof Error ? caught.message : '桌面控制请求失败，请重试。')
    } finally {
      if (attempt === epoch.current) setPending(null)
    }
  }

  useEffect(() => {
    void runSources()
    const requests = epoch
    return () => {
      requests.current++
    }
  }, [])

  return (
    <DesktopControlPanel
      permission={permission}
      accessibility={accessibility}
      screenProbeFailed={screenProbeFailed}
      accessibilityProbeFailed={accessibilityProbeFailed}
      activeModel={
        activeModel
          ? { name: activeModel.name, acceptsImages: activeModel.input?.includes('image') === true }
          : null
      }
      sources={sources}
      truncated={truncated}
      probed={probed}
      message={message}
      dump={dump}
      dumpProbed={dumpProbed}
      dumpMessage={dumpMessage}
      sessionUnlocked={sessionUnlocked}
      previewTarget={previewTarget}
      previewAllowed={previewAllowed}
      previewMessage={previewMessage}
      pending={pending}
      error={error}
      onRefresh={() => void runSources()}
      onOpenSettings={() => void run({ type: 'open-screen-recording-settings' })}
      onOpenAccessibilitySettings={() => void run({ type: 'open-accessibility-settings' })}
      onDump={() => void run({ type: 'accessibility-dump' })}
      onPreview={(nextX, nextY) => void run({ type: 'input-preview', x: nextX, y: nextY })}
      onConfirmClick={(nextX, nextY) => {
        if (!window.confirm(`将在屏幕坐标 (${nextX}, ${nextY}) 发送一次点击。确认继续？`)) {
          return
        }
        void run({ type: 'input-click', x: nextX, y: nextY, confirmed: true })
      }}
    />
  )
}
