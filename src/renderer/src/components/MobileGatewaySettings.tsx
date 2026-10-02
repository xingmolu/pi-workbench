import { useEffect, useState } from 'react'
import {
  MOBILE_KEEP_AWAKE_COPY,
  MOBILE_SECURITY_COPY,
  EMPTY_MOBILE_GATEWAY_STATE,
  isPreviewDevice,
  type MobileGatewayState
} from '../../../shared/mobile-gateway'
import { Smartphone } from 'lucide-react'
import { Segmented } from './SettingsPrimitives'
import { t } from '../../../shared/i18n'
import '../assets/desktop-settings.css'
import '../assets/settings-primitives.css'
import '../assets/mobile-settings.css'

function isTsNetUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host.endsWith('.ts.net')
  } catch {
    return false
  }
}

export default function MobileGatewaySettings(): React.JSX.Element {
  const [state, setState] = useState<MobileGatewayState>(EMPTY_MOBILE_GATEWAY_STATE)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false
    void window.pi
      .mobileGateway({ type: 'state' })
      .then((next) => {
        if (!ignore) setState(next)
      })
      .catch((error: unknown) => {
        if (ignore) return
        const message = error instanceof Error ? error.message : String(error)
        setState((prev) => ({ ...prev, error: message }))
      })
    const stop = window.pi.onEvent((event) => {
      if (event.event === 'mobile-gateway') setState(event.data)
    })
    return () => {
      ignore = true
      stop()
    }
  }, [])

  const run = async (command: Parameters<typeof window.pi.mobileGateway>[0]): Promise<void> => {
    setBusy(true)
    try {
      setState(await window.pi.mobileGateway(command))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setState((prev) => ({ ...prev, error: message }))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (text: string): Promise<void> => {
    try {
      setState(await window.pi.mobileGateway({ type: 'clipboard:copy', text }))
      setCopied(text)
      window.setTimeout(() => {
        setCopied((current) => (current === text ? null : current))
      }, 2000)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setState((prev) => ({ ...prev, error: message }))
    }
  }

  const port = state.port ?? 43124
  const serveCommand = `${state.tailscale.binary ?? 'tailscale'} serve --bg http://127.0.0.1:${port}`
  const cliMissing = !state.tailscale.available
  const copyLabel = (text: string, fallback: string): string =>
    copied === text ? t('已复制') : fallback

  return (
    <section className="mobile-gateway-settings">
      <header className="sp-page-header">
        <h2>{t('手机')}</h2>
        <p>
          {MOBILE_SECURITY_COPY} {MOBILE_KEEP_AWAKE_COPY}
        </p>
      </header>
      {state.error ? (
        <div className="sp-status is-error" role="alert">
          <span>{state.error}</span>
          <button type="button" onClick={() => void run({ type: 'state' })}>
            {t('重新读取')}
          </button>
        </div>
      ) : null}
      <fieldset disabled={busy}>
        <div className="sp-group">
          <div className="sp-group-header">
            <h3>{t('连接')}</h3>
          </div>
          <div className="sp-card settings-card">
            <div className="sp-row">
              <div className="sp-row-text">
                <span className="sp-row-label">
                  {t('本机网关')}
                  <span className={`mobile-state${state.running ? ' is-on' : ''}`}>
                    {state.running ? t('运行中') : t('未启动')}
                  </span>
                </span>
                <span className="sp-row-description">
                  {t('只监听 127.0.0.1；扫码时额外绑定当前 Wi‑Fi 私网地址。')}
                </span>
              </div>
              <div className="sp-row-control">
                <button
                  type="button"
                  className={state.running ? 'mobile-button' : 'mobile-button is-primary'}
                  onClick={() => void run({ type: state.running ? 'stop' : 'start' })}
                >
                  {state.running ? t('停止') : t('启动')}
                </button>
              </div>
            </div>
            {state.running ? (
              <div className="mobile-addresses">
                <div>
                  <span>{t('回环')}</span>
                  <code>{state.loopbackUrl}</code>
                </div>
                <div>
                  <span>{t('局域网')}</span>
                  {state.lanUrl ? <code>{state.lanUrl}</code> : <em>{t('未检测到局域网')}</em>}
                </div>
                {state.powerSave ? (
                  <div>
                    <span>{t('睡眠')}</span>
                    <em>{t('已请求避免睡眠')}</em>
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="sp-row">
              <div className="sp-row-text">
                <span className="sp-row-label">{t('配对')}</span>
                <span className="sp-row-description">
                  {t(
                    '一次性码约 5 分钟有效。开启 Tailscale Serve 后，二维码改用 https://*.ts.net。'
                  )}
                </span>
              </div>
              <div className="sp-row-control">
                <button
                  type="button"
                  className={state.running ? 'mobile-button is-primary' : 'mobile-button'}
                  onClick={() => void run({ type: 'pairing:create' })}
                >
                  {t('显示配对码')}
                </button>
              </div>
            </div>
            <div className="sp-row">
              <div className="sp-row-text">
                <span className="sp-row-label">{t('在电脑上预览')}</span>
                <span className="sp-row-description">
                  {t('不用手机：在一个手机大小的窗口里打开手机端，自动配对为「电脑预览」。')}
                </span>
              </div>
              <div className="sp-row-control">
                <button
                  type="button"
                  className="mobile-button"
                  onClick={() => void run({ type: 'preview:open' })}
                >
                  {t('打开预览')}
                </button>
              </div>
            </div>
            {state.pairing ? (
              <div className="mobile-pairing-card">
                <div className="qr-frame">
                  <img
                    alt={t('手机配对二维码')}
                    src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(state.pairing.qrSvg)}`}
                  />
                </div>
                <div className="pairing-meta">
                  <p className="pairing-token">
                    {t('配对码')} <strong>{state.pairing.token}</strong>
                  </p>
                  <code className="pairing-url">{state.pairing.url}</code>
                  {state.lanUrl && state.pairing.url !== state.lanUrl ? (
                    <code className="pairing-url">
                      {t('局域网 {lanUrl}', { lanUrl: state.lanUrl })}
                    </code>
                  ) : null}
                  <div className="mobile-copy-row">
                    <button
                      type="button"
                      className="mobile-button"
                      onClick={() => void copy(state.pairing!.url)}
                    >
                      {copyLabel(state.pairing.url, t('复制链接'))}
                    </button>
                    <span className="mobile-copy-confirm" aria-live="polite">
                      {copied === state.pairing.url ? t('已复制') : ''}
                    </span>
                  </div>
                  {isTsNetUrl(state.pairing.url) && !state.tailscale.serveUrl ? (
                    <p className="settings-reason">
                      {t('尾网地址已写入，请先开启 Tailscale Serve。')}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="sp-group">
          <div className="sp-group-header">
            <h3>{t('远程工作台')}</h3>
            <p>
              {t('让已配对的手机查看电脑上的内置浏览器和终端，例如在外面看本机开发页面的效果。')}
            </p>
          </div>
          <div className="sp-card settings-card">
            <div className="sp-row">
              <div className="sp-row-text">
                <span className="sp-row-label">{t('浏览器与终端')}</span>
                <span className="sp-row-description">
                  {state.remoteViews === 'control'
                    ? t(
                        '手机可以点击、输入、打开网页和在终端里执行命令；浏览器带着电脑上的登录状态。'
                      )
                    : state.remoteViews === 'view'
                      ? t('手机只能看画面和终端输出，不能操作。')
                      : t('手机看不到浏览器和终端。')}

                  {t('手机查看浏览器时，电脑上会自动展开浏览器面板。')}
                </span>
              </div>
              <div className="sp-row-control">
                <Segmented
                  label={t('远程工作台权限')}
                  value={state.remoteViews}
                  options={[
                    { value: 'off', label: t('关闭') },
                    { value: 'view', label: t('只看') },
                    { value: 'control', label: t('可操作') }
                  ]}
                  onChange={(access) => void run({ type: 'remote-views', access })}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="sp-group">
          <div className="sp-group-header">
            <h3>{t('已配对设备')}</h3>
            <p>{t('撤销后，该设备立即无法查看会话或驱动 Agent。')}</p>
          </div>
          <div className="sp-card settings-card">
            {state.devices.length === 0 ? (
              <p className="mobile-empty">{t('还没有配对设备。')}</p>
            ) : (
              <ul className="mobile-device-list">
                {state.devices.map((device) => (
                  <li key={device.deviceId}>
                    <span className="mobile-device-icon" aria-hidden="true">
                      <Smartphone size={15} />
                    </span>
                    <span>
                      <strong>{isPreviewDevice(device.name) ? t('电脑预览') : device.name}</strong>
                      <small>
                        {t('配对于 {toLocaleString}', {
                          toLocaleString: new Date(device.createdAt).toLocaleString()
                        })}
                      </small>
                    </span>
                    <button
                      type="button"
                      className="mobile-button is-danger"
                      onClick={() => void run({ type: 'device:revoke', deviceId: device.deviceId })}
                    >
                      {t('撤销')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="sp-group">
          <div className="sp-group-header">
            <h3>{t('远程访问')}</h3>
            <p>
              {t('用 Tailscale Serve 把回环地址代理到 MagicDNS；不需要端口转发，也不要用 Funnel。')}
            </p>
          </div>
          <div className="sp-card settings-card">
            <div className="sp-row">
              <div className="sp-row-text">
                <span className="sp-row-label">Tailscale</span>
                <div className="mobile-tailscale-status">
                  {cliMissing ? (
                    <span className="mobile-pill is-warn" role="status">
                      {state.tailscale.error ?? t('未找到 Tailscale CLI')}
                    </span>
                  ) : (
                    <>
                      <span className="mobile-pill is-ok">{t('CLI 已找到')}</span>
                      <span className="mobile-pill">
                        MagicDNS {state.tailscale.magicDns ?? t('未知')}
                      </span>
                      {state.tailscale.serveUrl ? (
                        <span className="mobile-pill is-ok">
                          Serve <code>{state.tailscale.serveUrl}</code>
                          <button
                            type="button"
                            className="mobile-pill-button"
                            onClick={() => void copy(state.tailscale.serveUrl!)}
                          >
                            {copyLabel(state.tailscale.serveUrl, t('复制'))}
                          </button>
                        </span>
                      ) : (
                        <span className="mobile-pill">{t('尚未开启 Serve')}</span>
                      )}
                    </>
                  )}
                </div>
              </div>
              <div className="sp-row-control">
                <button
                  type="button"
                  className="mobile-button"
                  onClick={() => void run({ type: 'tailscale:probe' })}
                >
                  {t('检测')}
                </button>
              </div>
            </div>
            <div className="sp-row is-stacked">
              <div className="sp-row-text">
                <span className="sp-row-label">Serve</span>
                <span className="sp-row-description">
                  {cliMissing
                    ? t('检测到 CLI 之前无法开启或关闭 Serve；也可以在终端运行下面的命令。')
                    : t('开启后手机可以通过尾网地址访问；也可以在终端运行下面的命令。')}
                </span>
              </div>
              <div className="sp-row-control">
                <div className="mobile-command">
                  <code>{serveCommand}</code>
                  <button
                    type="button"
                    className="mobile-button is-quiet"
                    onClick={() => void copy(serveCommand)}
                  >
                    {copyLabel(serveCommand, t('复制命令'))}
                  </button>
                </div>
                <div className="mobile-tailscale-actions">
                  <button
                    type="button"
                    className="mobile-button"
                    disabled={cliMissing}
                    title={
                      cliMissing ? (state.tailscale.error ?? t('未找到 Tailscale CLI')) : undefined
                    }
                    onClick={() => void run({ type: 'tailscale:unserve' })}
                  >
                    {t('关闭 Serve')}
                  </button>
                  <button
                    type="button"
                    className="mobile-button is-primary"
                    disabled={cliMissing}
                    title={
                      cliMissing ? (state.tailscale.error ?? t('未找到 Tailscale CLI')) : undefined
                    }
                    onClick={() => void run({ type: 'tailscale:serve' })}
                  >
                    {t('开启 Tailscale Serve')}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <p className="mobile-footnote">{t('Cloudflare Quick Tunnel 仅作备用，URL 每次会变。')}</p>
        </div>
      </fieldset>
    </section>
  )
}
