import { create } from 'zustand'

type AppOverlay = 'settings' | 'command' | 'navigation' | 'plugin-approval' | 'credential-grant'
type OverlayState = {
  active: AppOverlay | null
  open: (overlay: AppOverlay) => boolean
  close: (overlay: AppOverlay) => void
  fileSearch: { cwd: string; revision: number } | null
  fileSearchRevision: number
  requestFileSearch: (cwd: string) => void
  consumeFileSearch: (revision: number) => void
  /** A project-relative file to show in the Files panel, e.g. a path clicked in the terminal. */
  fileOpen: { cwd: string; path: string; revision: number } | null
  requestFileOpen: (cwd: string, path: string) => void
  consumeFileOpen: (revision: number) => void
}
/** One owner for app dialogs; native visibility ORs this with resize/local-menu suspension. */
export const createOverlayState = () =>
  create<OverlayState>((set, get) => ({
    active: null,
    fileSearch: null,
    fileSearchRevision: 0,
    fileOpen: null,
    open: (active) => {
      if (get().active && get().active !== active) return false
      set({ active })
      return true
    },
    close: (active) => {
      if (get().active === active) set({ active: null })
    },
    requestFileSearch: (cwd) => {
      const revision = get().fileSearchRevision + 1
      set({ fileSearch: { cwd, revision }, fileSearchRevision: revision })
    },
    consumeFileSearch: (revision) => {
      if (get().fileSearch?.revision === revision) set({ fileSearch: null })
    },
    requestFileOpen: (cwd, path) => {
      const revision = get().fileSearchRevision + 1
      set({ fileOpen: { cwd, path, revision }, fileSearchRevision: revision })
    },
    consumeFileOpen: (revision) => {
      if (get().fileOpen?.revision === revision) set({ fileOpen: null })
    }
  }))
export const useOverlayState = createOverlayState()

export class PaletteRequestEpoch {
  private revision = 0
  begin(identity: string): { revision: number; identity: string } {
    return { revision: ++this.revision, identity }
  }
  invalidate(): void {
    this.revision++
  }
  current(request: { revision: number; identity: string }, identity: string): boolean {
    return request.revision === this.revision && request.identity === identity
  }
}
