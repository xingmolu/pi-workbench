/** A resident SDK stream waits for admitted prompts, without sending a paid bootstrap prompt. */
export class InputStream<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private wake: (() => void) | undefined
  private closed = false
  push(value: T): void {
    if (this.closed) throw new Error('Claude input is closed')
    this.queue.push(value)
    this.wake?.()
  }
  close(): void {
    this.closed = true
    this.queue = []
    this.wake?.()
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (!this.closed) {
      if (this.queue.length) {
        yield this.queue.shift()!
        continue
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.wake = undefined
    }
  }
}
