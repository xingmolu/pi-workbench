export class PatchBatcher {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly publish: () => void,
    private readonly delayMs: number
  ) {}

  schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.publish()
    }, this.delayMs)
  }

  flush(): void {
    this.dispose()
    this.publish()
  }

  dispose(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
