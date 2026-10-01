/** Engines whose CLI is downloaded on demand instead of shipping inside the installer. */
export const DOWNLOADABLE_ENGINES = ['claude', 'codex'] as const
export type DownloadableEngine = (typeof DOWNLOADABLE_ENGINES)[number]

export function isDownloadableEngine(value: string): value is DownloadableEngine {
  return (DOWNLOADABLE_ENGINES as readonly string[]).includes(value)
}

export type EngineBinaryStatus = {
  runtimeId: DownloadableEngine
  version: string
  /** `unsupported`: no pinned build for this platform. */
  state: 'ready' | 'missing' | 'downloading' | 'error' | 'unsupported'
  /** Where a ready engine comes from: shipped with a development checkout, or downloaded. */
  source?: 'bundled' | 'downloaded' | 'override'
  /** Bytes of the download for this platform. */
  size: number
  received?: number
  error?: string
}
