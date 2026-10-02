import {
  EMPTY_MOBILE_GATEWAY_STATE,
  isPreviewDevice,
  mobileGatewayCommandSchema,
  type MobileGatewayCommand,
  type MobileGatewayState,
  type PairedDeviceRecord
} from '../shared/mobile-gateway'
import { MobileGatewayServer, type MobileViewsBridge } from './mobile-gateway'
import type { RemoteViewAccess } from '../shared/remote-views'
import { MobilePairingStore } from './mobile-pairing'
import type { MobileSessionBridge } from './mobile-session-bridge'
import {
  disableTailscaleServe,
  enableTailscaleServe,
  probeTailscale,
  remotePairingUrl
} from './mobile-tailscale'
import { t } from '../shared/i18n'

type DevicePersistence = {
  load(): PairedDeviceRecord[]
  save(devices: PairedDeviceRecord[]): void
}

export type MobileGatewayServiceOptions = {
  devices: DevicePersistence
  sessions: MobileSessionBridge
  publish(state: MobileGatewayState): void
  powerSave?: {
    start(): number
    stop(id: number): void
  }
  probeTailscale?: typeof probeTailscale
  enableTailscaleServe?: typeof enableTailscaleServe
  disableTailscaleServe?: typeof disableTailscaleServe
  writeClipboard?: (text: string) => void
  /** Shows the phone UI at `url` in a phone-sized desktop window. */
  openPreview?: (url: string) => void
  /** Listening port; the default is the fixed gateway port phones were paired with. */
  port?: number
  /** Remote workbench views; access is the desktop user's choice and defaults to off. */
  remoteViews?: {
    bridge: MobileViewsBridge
    get(): RemoteViewAccess
    set(access: RemoteViewAccess): void
  }
}

export class MobileGatewayService {
  readonly pairing: MobilePairingStore
  private readonly gateway: MobileGatewayServer
  private blocker = 0
  private tailscale = EMPTY_MOBILE_GATEWAY_STATE.tailscale
  private error: string | null = null
  constructor(private readonly options: MobileGatewayServiceOptions) {
    this.pairing = new MobilePairingStore({
      load: () => options.devices.load(),
      save: (devices) => {
        options.devices.save(devices)
        this.publish()
      }
    })
    this.gateway = new MobileGatewayServer({
      pairing: this.pairing,
      sessions: options.sessions,
      ...(options.port ? { port: options.port } : {}),
      ...(options.remoteViews ? { views: options.remoteViews.bridge } : {})
    })
  }

  getDiagnostics(): ReturnType<MobileGatewayServer['getDiagnostics']> {
    return this.gateway.getDiagnostics()
  }

  snapshot(): MobileGatewayState {
    const offer = this.pairing.currentOffer()
    const remoteUrl = offer
      ? remotePairingUrl({
          serveUrl: this.tailscale.serveUrl,
          magicDns: this.tailscale.magicDns,
          token: offer.token
        })
      : null
    return {
      running: this.gateway.isRunning,
      port: this.gateway.listenPort,
      loopbackUrl: this.gateway.loopbackUrl(),
      lanUrl: this.gateway.lanUrl(),
      lanAddress: this.gateway.getLanAddress(),
      pairing:
        offer && this.gateway.isRunning
          ? this.gateway.pairingPayload(offer.token, offer.expiresAt, remoteUrl)
          : null,
      devices: this.pairing.list(),
      powerSave: this.blocker !== 0,
      tailscale: this.tailscale,
      remoteViews: this.options.remoteViews?.get() ?? 'off',
      error: this.error
    }
  }

  async dispatch(command: unknown): Promise<MobileGatewayState> {
    const request = mobileGatewayCommandSchema.parse(command)
    try {
      this.error = null
      await this.run(request)
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
    const state = this.snapshot()
    this.options.publish(state)
    return state
  }

  async shutdown(): Promise<void> {
    await this.gateway.stop()
    this.stopPowerSave()
  }

  private async run(command: MobileGatewayCommand): Promise<void> {
    if (command.type === 'state') {
      this.tailscale = await (this.options.probeTailscale ?? probeTailscale)()
      return
    }
    if (command.type === 'tailscale:probe') {
      this.tailscale = await (this.options.probeTailscale ?? probeTailscale)()
      if (this.tailscale.error) this.error = this.tailscale.error
      return
    }
    if (command.type === 'start') {
      await this.gateway.start()
      this.startPowerSave()
      this.tailscale = await (this.options.probeTailscale ?? probeTailscale)()
      return
    }
    if (command.type === 'stop') {
      await this.gateway.stop()
      this.stopPowerSave()
      return
    }
    if (command.type === 'pairing:create') {
      if (!this.gateway.isRunning) await this.gateway.start()
      this.startPowerSave()
      this.tailscale = await (this.options.probeTailscale ?? probeTailscale)()
      this.pairing.createOffer()
      return
    }
    if (command.type === 'preview:open') {
      const open = this.options.openPreview
      if (!open) throw new Error(t('当前环境不支持预览'))
      if (!this.gateway.isRunning) await this.gateway.start()
      this.startPowerSave()
      // One preview device at a time: the window pairs afresh, replacing the last one.
      for (const device of this.pairing.list())
        if (isPreviewDevice(device.name)) this.pairing.revoke(device.deviceId)
      const url = this.gateway.loopbackUrl(this.pairing.createOffer().token)
      if (!url) throw new Error(t('网关未启动'))
      open(url)
      return
    }
    if (command.type === 'remote-views') {
      if (!this.options.remoteViews) throw new Error(t('远程工作台不可用'))
      this.options.remoteViews.set(command.access)
      // Turning it off takes effect at once, not at the phone's next reconnect.
      if (command.access === 'off') this.gateway.closeViews()
      return
    }
    if (command.type === 'device:revoke') {
      this.pairing.revoke(command.deviceId)
      return
    }
    if (command.type === 'clipboard:copy') {
      const write = this.options.writeClipboard
      if (!write) throw new Error(t('无法复制到剪贴板'))
      write(command.text)
      return
    }
    if (command.type === 'tailscale:serve') {
      if (!this.gateway.isRunning) await this.gateway.start()
      this.startPowerSave()
      const port = this.gateway.listenPort
      if (!port) throw new Error(t('网关未启动'))
      this.tailscale = await (this.options.enableTailscaleServe ?? enableTailscaleServe)(port)
      if (!this.tailscale.serveUrl) {
        const message = this.tailscale.error ?? t('未能开启 Tailscale Serve')
        this.tailscale = { ...this.tailscale, error: message }
        throw new Error(message)
      }
      return
    }
    if (command.type === 'tailscale:unserve') {
      this.tailscale = await (this.options.disableTailscaleServe ?? disableTailscaleServe)()
      if (this.tailscale.error) throw new Error(this.tailscale.error)
    }
  }

  private startPowerSave(): void {
    if (this.blocker) return
    const api = this.options.powerSave
    if (!api) return
    this.blocker = api.start()
  }

  private stopPowerSave(): void {
    if (!this.blocker || !this.options.powerSave) return
    this.options.powerSave.stop(this.blocker)
    this.blocker = 0
  }

  private publish(): void {
    this.options.publish(this.snapshot())
  }
}
