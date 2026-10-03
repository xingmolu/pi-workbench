import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { PiPackageRoot } from '../shared/workbench-host-contracts'
import { t } from '../shared/i18n'

type Watch = (
  path: string,
  listener: (file: string | null) => void,
  onError: () => void
) => { close(): void }

export type PluginDevelopmentOptions = {
  folders: { get(): string[]; set(folders: string[]): void }
  /** A folder's files settled after a change. */
  onChange(folder: string): void
  /** How long a folder must be quiet before `onChange`; editors save in bursts. */
  debounceMs?: number
  watch?: Watch
}

/** Changes here never affect the running plugin. */
const IGNORED = /(^|[\\/])(\.git|node_modules|\.DS_Store)([\\/]|$)|~$|\.swp$/

const nodeWatch: Watch = (path, listener, onError) => {
  const watcher: FSWatcher = fsWatch(path, { recursive: true }, (_event, file) =>
    listener(file === null ? null : String(file))
  )
  watcher.on('error', onError)
  return watcher
}

/**
 * Plugins under development load straight from the author's folder instead of being copied
 * into `desktop-plugins`, and reload whenever a file in that folder changes. The folder list
 * is a preference; the author added each one, so loading it needs no review.
 */
export class PluginDevelopment {
  private readonly watchers = new Map<string, { close(): void }>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly options: PluginDevelopmentOptions) {}

  folders(): string[] {
    return [...this.options.folders.get()]
  }

  /** Watches every folder; call once at startup. */
  start(): void {
    for (const folder of this.folders()) this.watchFolder(folder)
  }

  /** Adds a folder and returns its real path. */
  async add(path: string): Promise<string> {
    const info = await stat(path).catch(() => null)
    if (!info?.isDirectory()) throw new Error(t('所选路径不是文件夹'))
    const folder = await realpath(path)
    const folders = this.folders()
    if (!folders.includes(folder)) this.options.folders.set([...folders, folder])
    this.watchFolder(folder)
    return folder
  }

  remove(folder: string): void {
    this.unwatch(folder)
    this.options.folders.set(this.folders().filter((candidate) => candidate !== folder))
  }

  /** Development folders come before installed plugins, so one with the same id wins. */
  async roots(): Promise<PiPackageRoot[]> {
    const roots: PiPackageRoot[] = []
    for (const path of this.folders())
      if ((await stat(path).catch(() => null))?.isDirectory())
        roots.push({ path, source: t('开发中'), scope: 'user', hasExecutablePiResources: false })
    return roots
  }

  dispose(): void {
    for (const folder of [...this.watchers.keys()]) this.unwatch(folder)
  }

  private watchFolder(folder: string): void {
    if (this.watchers.has(folder)) return
    try {
      const watcher = (this.options.watch ?? nodeWatch)(
        folder,
        (file) => {
          if (file !== null && IGNORED.test(file)) return
          clearTimeout(this.timers.get(folder))
          this.timers.set(
            folder,
            setTimeout(() => {
              this.timers.delete(folder)
              this.options.onChange(folder)
            }, this.options.debounceMs ?? 250)
          )
        },
        // The folder was deleted or became unreadable; adding it again restarts watching.
        () => this.unwatch(folder)
      )
      this.watchers.set(folder, watcher)
    } catch {
      /* A missing folder is shown as unavailable in Settings. */
    }
  }

  private unwatch(folder: string): void {
    clearTimeout(this.timers.get(folder))
    this.timers.delete(folder)
    this.watchers.get(folder)?.close()
    this.watchers.delete(folder)
  }
}
