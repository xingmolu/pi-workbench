type NativeFocusTarget = {
  /** Owner, source session, owned/current view and current focus still agree. */
  valid: () => boolean
  visible: () => boolean
  focus: () => void
}

/** One Main-owned target; the renderer can finish an opaque token, never name a WebContents. */
export class NativePaletteFocus {
  private origin: { token: string; target: NativeFocusTarget; restoreUntil: number | null } | null =
    null
  constructor(private readonly now: () => number = Date.now) {}
  capture(token: string, target: NativeFocusTarget): void {
    this.origin = { token, target, restoreUntil: null }
  }
  invalidate(): void {
    this.origin = null
  }
  interruptPending(): void {
    if (this.origin?.restoreUntil !== null) this.invalidate()
  }
  finish(token: string, restore: boolean): void {
    if (this.origin?.token !== token) return
    if (!restore) {
      this.invalidate()
      return
    }
    // A duplicate finish cannot extend the bounded restoration window.
    this.origin.restoreUntil ??= this.now() + 1000
    this.surfaceUpdated()
  }
  surfaceUpdated(): void {
    const origin = this.origin
    if (!origin || origin.restoreUntil === null) return
    if (this.now() > origin.restoreUntil || !origin.target.valid()) {
      this.invalidate()
      return
    }
    if (!origin.target.visible()) return
    this.invalidate()
    origin.target.focus()
  }
}
