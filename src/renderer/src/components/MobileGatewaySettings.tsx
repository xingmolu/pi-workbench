import { useEffect, useState } from 'react'
import {
  MOBILE_KEEP_AWAKE_COPY,
  MOBILE_SECURITY_COPY,
  EMPTY_MOBILE_GATEWAY_STATE,
  type MobileGatewayState
} from '../../../shared/mobile-gateway'
import '../assets/desktop-settings.css'

export default function MobileGatewaySettings(): React.JSX.Element {
  const [state, setState] = useState<MobileGatewayState>(EMPTY_MOBILE_GATEWAY_STATE)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let ignore = false
    void window.pi.mobileGateway({ type: 'state' }).then((next) => {
      if (!ignore) setState(next)
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
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="desktop-preferences mobile-gateway-settings">
      <h2>手机</h2>
      <p className="inline-hint">{MOBILE_SECURITY_COPY}</p>
      <p className="inline-hint">{MOBILE_KEEP_AWAKE_COPY}</p>
      {state.error ? (
        <div role="alert">
          {state.error}
          <button type="button" onClick={() => void run({ type: 'state' })}>
            重新读取
          </button>
        </div>
      ) : null}
      <fieldset disabled={busy}>
        <label className="desktop-preference-row">
          <span>
            <strong>本机网关</strong>
            <small>只监听 127.0.0.1；局域网扫码会额外绑定当前 Wi‑Fi 私网地址，不会绑定 0.0.0.0。</small>
          </span>
          <button type="button" onClick={() => void run({ type: state.running ? 'stop' : 'start' })}>
            {state.running ? '停止' : '启动'}
          </button>
        </label>
        {state.running ? (
          <p className="inline-hint">
            回环 {state.loopbackUrl}
            {state.lanUrl ? ` · 局域网 ${state.lanUrl}` : ' · 未检测到局域网地址'}
          </p>
        ) : null}
        <label className="desktop-preference-row">
          <span>
            <strong>局域网配对二维码</strong>
            <small>一次性配对码，约 5 分钟有效。用自己的手机扫描。</small>
          </span>
          <button type="button" onClick={() => void run({ type: 'pairing:create' })}>
            显示配对码
          </button>
        </label>
        {state.pairing ? (
          <div className="mobile-pairing-card">
            <img
              alt="手机配对二维码"
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(state.pairing.qrSvg)}`}
            />
            <p>
              <strong>配对码 {state.pairing.token}</strong>
              <small>{state.pairing.url}</small>
            </p>
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(state.pairing!.url)}
            >
              复制链接
            </button>
          </div>
        ) : null}
        <div className="desktop-preference-row">
          <span>
            <strong>已配对设备</strong>
            <small>撤销后该设备立即无法查看会话或驱动 Agent。</small>
          </span>
        </div>
        {state.devices.length === 0 ? (
          <p className="inline-hint">还没有配对设备。</p>
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
                  onClick={() => void run({ type: 'device:revoke', deviceId: device.deviceId })}
                >
                  撤销
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="desktop-preference-row">
          <span>
            <strong>远程：Tailscale</strong>
            <small>
              推荐用 Tailscale Serve 把回环网关代理到尾网 MagicDNS（*.ts.net），不要做公网端口转发。不要使用 Funnel。
            </small>
          </span>
          <button type="button" onClick={() => void run({ type: 'tailscale:probe' })}>
            检测
          </button>
        </div>
        <p className="inline-hint">
          {state.tailscale.available
            ? `MagicDNS：${state.tailscale.magicDns ?? '未知'} · ${
                state.tailscale.serveUrl ?? '尚未开启 Serve'
              }`
            : state.tailscale.error ?? '未检测到 Tailscale CLI'}
        </p>
        <p className="inline-hint">
          命令：<code>tailscale serve --bg http://127.0.0.1:{state.port ?? 43124}</code>
        </p>
        <div className="mobile-tailscale-actions">
          <button type="button" onClick={() => void run({ type: 'tailscale:serve' })}>
            开启 Tailscale Serve
          </button>
          <button type="button" onClick={() => void run({ type: 'tailscale:unserve' })}>
            关闭 Serve
          </button>
        </div>
        {state.powerSave ? (
          <p className="inline-hint">已请求系统避免睡眠。合盖或强制睡眠仍会断开手机。</p>
        ) : null}
        <p className="inline-hint">
          Cloudflare Quick Tunnel 是可选备用路径：
          <code> cloudflared tunnel --url http://127.0.0.1:{state.port ?? 43124}</code>
          。URL 每次会变，本产品不把它当作主路。
        </p>
      </fieldset>
    </section>
  )
}
