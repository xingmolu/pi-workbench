/** What Settings shows about new versions of the desktop app itself. */
export type AppUpdateStatus = {
  version: string
  /** Prerelease builds follow the nightly channel. */
  channel: 'nightly' | 'stable'
  /** Installs in place (Windows, AppImage) or opens the release page to download (macOS, deb). */
  install: 'auto' | 'manual'
  /** A GitHub token is stored for reading releases of a private repository. */
  hasToken: boolean
  checkedAt?: number
} & (
  | { state: 'idle' | 'checking' | 'none' }
  | { state: 'available'; next: string; releaseUrl: string }
  | { state: 'downloading'; next: string; percent: number }
  | { state: 'ready'; next: string }
  | { state: 'needs-token'; message: string }
  | { state: 'error'; message: string }
  | { state: 'unsupported'; message: string }
)

export type AppUpdateCommand =
  | { type: 'status' }
  | { type: 'check' }
  | { type: 'download' }
  | { type: 'install' }
  | { type: 'open-release' }
  | { type: 'token:set'; token: string }
  | { type: 'token:clear' }

export const APP_UPDATE_CHANNEL = 'pi:app-update'
export const APP_UPDATE_EVENT_CHANNEL = 'pi:app-update:event'
export const RELEASES_REPOSITORY = { owner: 'xingmolu', repo: 'pi-desktop' } as const
