export class ProjectOpenCoordinator<Result> {
  private tail: Promise<void> = Promise.resolve()
  private restorePromise: Promise<Result | null> | null = null
  private userOpenRequested = false

  restoreOnce(operation: () => Promise<Result | null>): Promise<Result | null> {
    this.restorePromise ??= this.enqueue(() => {
      return this.userOpenRequested ? Promise.resolve(null) : operation()
    })
    return this.restorePromise
  }

  async restoreThenRead(
    restore: () => Promise<Result | null>,
    readCurrent: () => Promise<Result>
  ): Promise<Result> {
    await this.restoreOnce(restore)
    return this.runStateRead(readCurrent)
  }

  runUserOpen(operation: () => Promise<Result>): Promise<Result> {
    this.userOpenRequested = true
    return this.enqueue(operation)
  }

  runStateRead(operation: () => Promise<Result>): Promise<Result> {
    return this.enqueue(operation)
  }

  private enqueue<OperationResult>(
    operation: () => Promise<OperationResult>
  ): Promise<OperationResult> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
