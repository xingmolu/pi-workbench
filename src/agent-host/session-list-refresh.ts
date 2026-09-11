export class SessionListRefresh {
  private sequence = 0

  async run<T>(
    generation: number,
    readGeneration: () => number,
    load: () => Promise<T>,
    publish: (value: T) => void
  ): Promise<boolean> {
    if (generation !== readGeneration()) return false
    const sequence = ++this.sequence
    const value = await load()
    if (sequence !== this.sequence || generation !== readGeneration()) return false
    publish(value)
    return true
  }
}
