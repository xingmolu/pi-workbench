import { t } from '../shared/i18n'

/** Stops the agent from anywhere while Pi Desktop sits behind the app it drives. */
export const COMPUTER_USE_STOP_ACCELERATOR = 'CommandOrControl+Shift+Escape'

export type ComputerUseIndicatorDeps = {
  registerShortcut(accelerator: string, callback: () => void): boolean
  unregisterShortcut(accelerator: string): void
  setBadge(text: string): void
  notify(title: string, body: string): void
  stop(owner: string): void
}

/**
 * Shows that an agent is controlling the desktop while Pi Desktop itself is in the
 * background: a Dock badge, one notification per control session, and a global shortcut
 * that stops the run. Everything is withdrawn when the run ends.
 */
export class ComputerUseIndicator {
  private owner: string | null = null
  private shortcut = false

  constructor(private readonly deps: ComputerUseIndicatorDeps) {}

  get active(): string | null {
    return this.owner
  }

  begin(owner: string): void {
    if (this.owner === owner) return
    if (this.owner) this.end(this.owner)
    this.owner = owner
    this.shortcut = this.deps.registerShortcut(COMPUTER_USE_STOP_ACCELERATOR, () => {
      const current = this.owner
      if (!current) return
      this.end(current)
      this.deps.stop(current)
    })
    this.deps.setBadge('●')
    this.deps.notify(
      t('Pi 正在操作你的电脑'),
      this.shortcut
        ? t('按 {shortcut} 或在 Pi Desktop 中点停止即可中止。', {
            shortcut: process.platform === 'darwin' ? '⌘⇧Esc' : 'Ctrl+Shift+Esc'
          })
        : t('在 Pi Desktop 中点停止即可中止。')
    )
  }

  /** Ends the indicator for this owner; other owners' calls are ignored. */
  end(owner: string): void {
    if (this.owner !== owner) return
    this.owner = null
    if (this.shortcut) this.deps.unregisterShortcut(COMPUTER_USE_STOP_ACCELERATOR)
    this.shortcut = false
    this.deps.setBadge('')
  }
}
