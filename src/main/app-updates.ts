import {
  RELEASES_REPOSITORY,
  type AppUpdateCommand,
  type AppUpdateStatus
} from '../shared/app-updates'
import { t } from '../shared/i18n'

/** The part of electron-updater's `autoUpdater` this module drives. */
export type Updater = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  setFeedURL(options: Record<string, unknown>): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

export type AppUpdatesOptions = {
  version: string
  platform: NodeJS.Platform
  /** False in development and tests: there is nothing installed to replace. */
  packaged: boolean
  /** Set for an AppImage, which can replace itself; a deb cannot. */
  appImage?: string
  updater: () => Updater
  token: { read(): string | undefined; write(token: string | undefined): void }
  openExternal(url: string): void
  onChange(status: AppUpdateStatus): void
  /** First check after start, then every `intervalMs`. */
  firstCheckMs?: number
  intervalMs?: number
}

type State = Pick<AppUpdateStatus, 'state'> & Record<string, unknown>

/**
 * Checks the repository's GitHub releases for a newer build. Windows and AppImage builds download
 * and install in place; macOS builds are only ad-hoc signed, which Squirrel.Mac refuses to swap,
 * so there (and for deb) the release page opens for a manual download instead.
 */
export class AppUpdates {
  private state: State = { state: 'idle' }
  private checkedAt: number | undefined
  private wired: Updater | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly options: AppUpdatesOptions) {}

  private get install(): 'auto' | 'manual' {
    if (this.options.platform === 'win32') return 'auto'
    if (this.options.platform === 'linux' && this.options.appImage) return 'auto'
    return 'manual'
  }

  private get nightly(): boolean {
    return this.options.version.includes('-')
  }

  status(): AppUpdateStatus {
    return {
      version: this.options.version,
      channel: this.nightly ? 'nightly' : 'stable',
      install: this.install,
      hasToken: Boolean(this.options.token.read()),
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      ...(this.state as object)
    } as AppUpdateStatus
  }

  /** Starts the periodic checks; nothing happens for an unpackaged build. */
  start(): void {
    if (!this.options.packaged) {
      this.set({ state: 'unsupported', message: t('开发版本不检查更新') })
      return
    }
    const check = (): void => void this.check().catch(() => undefined)
    setTimeout(check, this.options.firstCheckMs ?? 15_000).unref?.()
    this.timer = setInterval(check, this.options.intervalMs ?? 4 * 60 * 60 * 1000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async handle(command: AppUpdateCommand): Promise<AppUpdateStatus> {
    switch (command.type) {
      case 'status':
        break
      case 'check':
        await this.check()
        break
      case 'download':
        if (this.state.state !== 'available') throw new Error(t('没有可下载的新版本'))
        if (this.install === 'manual') this.options.openExternal(this.releaseUrl())
        else await this.updater().downloadUpdate()
        break
      case 'install':
        if (this.state.state !== 'ready') throw new Error(t('新版本还没有下载好'))
        this.updater().quitAndInstall()
        break
      case 'open-release':
        this.options.openExternal(this.releaseUrl())
        break
      case 'token:set': {
        const token = command.token.trim()
        if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new Error(t('这不像是 GitHub 令牌'))
        this.options.token.write(token)
        this.wired = undefined
        await this.check()
        break
      }
      case 'token:clear':
        this.options.token.write(undefined)
        this.wired = undefined
        this.set({ state: 'idle' })
        break
    }
    return this.status()
  }

  private releaseUrl(): string {
    return 'next' in this.state
      ? this.releaseUrlFor(String(this.state.next))
      : `https://github.com/${RELEASES_REPOSITORY.owner}/${RELEASES_REPOSITORY.repo}/releases`
  }

  private async check(): Promise<void> {
    if (!this.options.packaged) return
    // A downloaded update waits for the user; checking again would only hide its button.
    if (['checking', 'downloading', 'ready'].includes(this.state.state)) return
    this.set({ state: 'checking' })
    try {
      const result = await this.updater().checkForUpdates()
      this.checkedAt = Date.now()
      // electron-updater answers null when this kind of install cannot update itself.
      if (result == null && (this.state.state as string) === 'checking') {
        this.set({
          state: 'unsupported',
          message: t('这种安装方式不能检查更新，请到发布页下载新版本')
        })
        return
      }
      // A result event has moved the state on; otherwise nothing newer was found.
      if ((this.state.state as string) === 'checking') this.set({ state: 'none' })
    } catch (error) {
      this.checkedAt = Date.now()
      this.fail(error)
    }
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    // A private repository answers 404 to anonymous release reads.
    if (/\b(401|403|404)\b|Not Found|Bad credentials/i.test(message))
      this.set({
        state: 'needs-token',
        message: this.options.token.read()
          ? t('GitHub 令牌无效或没有这个仓库的读取权限')
          : t('发布页在私有仓库里，需要填写一个只读的 GitHub 令牌才能检查更新')
      })
    else
      this.set({
        state: 'error',
        message: t('检查更新失败：{value}', { value: message.slice(0, 200) })
      })
  }

  private updater(): Updater {
    if (this.wired) return this.wired
    const updater = this.options.updater()
    const token = this.options.token.read()
    updater.autoDownload = this.install === 'auto'
    updater.autoInstallOnAppQuit = this.install === 'auto'
    updater.allowPrerelease = this.nightly
    updater.setFeedURL({
      provider: 'github',
      ...RELEASES_REPOSITORY,
      releaseType: this.nightly ? 'prerelease' : 'release',
      ...(token ? { private: true, token } : {})
    })
    if (!this.listening) {
      this.listening = true
      updater.on('update-available', ((info: { version: string }) => {
        this.set({
          state: 'available',
          next: info.version,
          releaseUrl: this.releaseUrlFor(info.version)
        })
      }) as never)
      updater.on('download-progress', ((progress: { percent: number }) => {
        const next = 'next' in this.state ? this.state.next : ''
        this.set({ state: 'downloading', next, percent: Math.round(progress.percent) })
      }) as never)
      updater.on('update-downloaded', ((info: { version: string }) => {
        this.set({ state: 'ready', next: info.version })
      }) as never)
      updater.on('error', ((error: Error) => this.fail(error)) as never)
    }
    this.wired = updater
    return updater
  }

  private listening = false

  private releaseUrlFor(version: string): string {
    return `https://github.com/${RELEASES_REPOSITORY.owner}/${RELEASES_REPOSITORY.repo}/releases/tag/v${version}`
  }

  private set(state: State): void {
    this.state = state
    this.options.onChange(this.status())
  }
}
