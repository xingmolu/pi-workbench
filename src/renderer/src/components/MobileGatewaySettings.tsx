import { useEffect, useState } from 'react'
import {
  MOBILE_KEEP_AWAKE_COPY,
  MOBILE_SECURITY_COPY,
  EMPTY_MOBILE_GATEWAY_STATE,
  type MobileGatewayState
} from '../../../shared/mobile-gateway'
import '../assets/desktop-settings.css'

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
    copied === text ? '已复制' : fallback

  return (
    <section className="desktop-preferences mobile-gateway-settings">
      <h2>手机</h2>
      <div className="callout">
        <p>
          {MOBILE_SECURITY_COPY} {MOBILE_KEEP_AWAKE_COPY}
        </p>
      </div>
      {state.error ? (
        <div role="alert">
          {state.error}
          <button type="button" className="secondary-button" onClick={() => void run({ type: 'state' })}>
            重新读取
          </button>
        </div>
      ) : null}
      <fieldset disabled={busy}>
        <div className="settings-card">
          <div className="desktop-preference-row">
            <span>
              <strong>本机网关</strong>
              <small>只监听 127.0.0.1；扫码时额外绑定当前 Wi‑Fi 私网地址。</small>
            </span>
            <button
              type="button"
              className={state.running ? 'secondary-button' : 'primary-button'}
              onClick={() => void run({ type: state.running ? 'stop' : 'start' })}
            >
              {state.running ? '停止' : '启动'}
            </button>
          </div>
          {state.running ? (
            <div className="chip-row">
              <span className="chip is-ok">回环 {state.loopbackUrl}</span>
              {state.lanUrl ? (
                <span className="chip">局域网 {state.lanUrl}</span>
              ) : (
                <span className="chip">未检测到局域网</span>
              )}
              {state.powerSave ? <span className="chip">已请求避免睡眠</span> : null}
            </div>
          ) : null}
        </div>

        <div className="settings-card">
          <div className="desktop-preference-row">
            <span>
              <strong>配对</strong>
              <small>一次性码约 5 分钟。Serve 开启后二维码改用 https://*.ts.net。</small>
            </span>
            <button
              type="button"
              className="primary-button"
              onClick={() => void run({ type: 'pairing:create' })}
            >
              显示配对码
            </button>
          </div>
          {state.pairing ? (
            <div className="mobile-pairing-card">
              <div className="qr-frame">
                <img
                  alt="手机配对二维码"
                  src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(state.pairing.qrSvg)}`}
                />
              </div>
              <div className="pairing-meta">
                <p className="pairing-token">配对码 {state.pairing.token}</p>
                <code className="pairing-url">{state.pairing.url}</code>
                {state.lanUrl && state.pairing.url !== state.lanUrl ? (
                  <code className="pairing-url">局域网 {state.lanUrl}</code>
                ) : null}
                <div className="mobile-copy-row">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void copy(state.pairing!.url)}
                  >
                    {copyLabel(state.pairing.url, '复制链接')}
                  </button>
                  <span className="mobile-copy-confirm" aria-live="polite">
                    {copied === state.pairing.url ? '已复制' : ''}
                  </span>
                </div>
                {isTsNetUrl(state.pairing.url) && !state.tailscale.serveUrl ? (
                  <p className="settings-reason">尾网地址已写入，请先开启 Tailscale Serve。</p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="settings-card">
          <div className="desktop-preference-row">
            <span>
              <strong>已配对设备</strong>
              <small>撤销后立即无法查看会话或驱动 Agent。</small>
            </span>
          </div>
          {state.devices.length === 0 ? (
            <p className="settings-reason">还没有配对设备。</p>
          ) : (
            <ul className="mobile-device-list">
              {state.devices.map((device) => (
                <li key={device.deviceId}>
                  <span>
                    <strong>{device.name}</strong>
                    <small>{new Date(device.createdAt).toLocaleString()}</small>
                  </span>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => void run({ type: 'device:revoke', deviceId: device.deviceId })}
                  >
                    撤销
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="settings-card">
          <div className="desktop-preference-row">
            <span>
              <strong>远程：Tailscale</strong>
              <small>用 Serve 把回环代理到 MagicDNS，不要端口转发，不要 Funnel。</small>
            </span>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void run({ type: 'tailscale:probe' })}
            >
              检测
            </button>
          </div>
          {cliMissing ? (
            <>
              <div className="mobile-tailscale-status">
                <span className="chip is-warn" role="status">
                  {state.tailscale.error ?? '未找到 Tailscale CLI'}
                </span>
              </div>
              <p className="settings-reason">检测到 CLI 之前无法开启或关闭 Serve。</p>
            </>
          ) : (
            <div className="mobile-tailscale-status">
              <span className="chip is-ok">CLI 已找到</span>
              <span className="chip">MagicDNS {state.tailscale.magicDns ?? '未知'}</span>
              {state.tailscale.serveUrl ? (
                <span className="chip is-ok">
                  Serve <code>{state.tailscale.serveUrl}</code>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void copy(state.tailscale.serveUrl!)}
                  >
                    {copyLabel(state.tailscale.serveUrl, '复制')}
                  </button>
                </span>
              ) : (
                <span className="chip">尚未开启 Serve</span>
              )}
            </div>
          )}
          <div className="mobile-copy-row">
            <code className="pairing-url">{serveCommand}</code>
            <button type="button" className="secondary-button" onClick={() => void copy(serveCommand)}>
              {copyLabel(serveCommand, '复制命令')}
            </button>
          </div>
          <div className="mobile-tailscale-actions">
            <button
              type="button"
              className="primary-button"
              disabled={cliMissing}
              title={cliMissing ? (state.tailscale.error ?? '未找到 Tailscale CLI') : undefined}
              onClick={() => void run({ type: 'tailscale:serve' })}
            >
              开启 Tailscale Serve
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={cliMissing}
              title={cliMissing ? (state.tailscale.error ?? '未找到 Tailscale CLI') : undefined}
              onClick={() => void run({ type: 'tailscale:unserve' })}
            >
              关闭 Serve
            </button>
          </div>
          <p className="settings-reason">
            Cloudflare Quick Tunnel 仅作备用，URL 每次会变。
          </p>
        </div>
      </fieldset>
    </section>
  )
}
