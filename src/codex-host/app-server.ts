import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export type AppServerNotification = { method: string; params: Record<string, unknown> }
export type AppServerRequest = {
  id: number | string
  method: string
  params: Record<string, unknown>
}

export type AppServerOptions = {
  executable: string
  /** Codex keeps config, logins and transcripts here; one directory per desktop engine. */
  codexHome: string
  /** Extra `-c key=value` overrides, e.g. a test model provider. */
  config?: string[]
  env?: Record<string, string | undefined>
  onNotification(message: AppServerNotification): void
  /** Approvals and token refreshes; the answer is sent back as the result. */
  onRequest(message: AppServerRequest): Promise<unknown>
  onExit(error?: Error): void
}

/**
 * One `codex app-server` process speaking newline-delimited JSON-RPC over stdio. Requests are
 * answered in order of arrival; the process is the only owner of the Codex home it runs in.
 */
export class AppServerClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; method: string }
  >()
  private sequence = 0
  private buffer = ''
  private closed = false
  private stderr = ''

  constructor(private readonly options: AppServerOptions) {
    const args = ['app-server']
    for (const entry of options.config ?? []) args.push('-c', entry)
    this.child = spawn(options.executable, args, {
      env: {
        ...process.env,
        ...options.env,
        CODEX_HOME: options.codexHome,
        RUST_LOG: process.env.PI_DESKTOP_CODEX_LOG ?? 'error'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000)
    })
    this.child.once('error', (error) => this.close(error))
    this.child.once('exit', (code, signal) =>
      this.close(
        this.closed
          ? undefined
          : new Error(
              `Codex 已退出（${signal ?? code}）${this.stderr ? `：${lastLine(this.stderr)}` : ''}`
            )
      )
    )
  }

  async initialize(version: string): Promise<{ codexHome: string; userAgent: string }> {
    const result = (await this.request('initialize', {
      clientInfo: { name: 'pi_desktop', title: 'Pi Desktop', version },
      // External ChatGPT tokens (lent by Pi) are an experimental app-server API.
      capabilities: { experimentalApi: true, requestAttestation: false }
    })) as { codexHome: string; userAgent: string }
    this.notify('initialized')
    return result
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex 未在运行'))
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.closed) this.write(params ? { method, params } : { method })
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.child.stdin.end()
    this.child.kill()
    this.rejectAll(new Error('Codex 已停止'))
  }

  /** Resolves once the process has gone, so its home directory can be removed. */
  exited(): Promise<void> {
    return this.child.exitCode !== null || this.child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => this.child.once('exit', () => resolve()))
  }

  private write(message: unknown): void {
    if (this.closed || !this.child.stdin.writable) return
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = message.id as number | string | undefined
    const method = typeof message.method === 'string' ? message.method : undefined
    if (method && id !== undefined) {
      const request = { id, method, params: (message.params ?? {}) as Record<string, unknown> }
      void this.options.onRequest(request).then(
        (result) => this.write({ id, result: result ?? {} }),
        (error: unknown) =>
          this.write({
            id,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) }
          })
      )
      return
    }
    if (method) {
      this.options.onNotification({
        method,
        params: (message.params ?? {}) as Record<string, unknown>
      })
      return
    }
    if (typeof id !== 'number') return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    const error = message.error as { message?: string } | undefined
    if (error) pending.reject(new Error(error.message ?? `${pending.method} 失败`))
    else pending.resolve(message.result)
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private close(error?: Error): void {
    const unexpected = !this.closed
    this.closed = true
    this.rejectAll(error ?? new Error('Codex 已停止'))
    if (unexpected) this.options.onExit(error)
  }
}

function lastLine(text: string): string {
  return (
    text
      .trim()
      .split('\n')
      .at(-1)
      // ANSI colour codes from the CLI's logger.
      ?.replace(/\u001b\[[0-9;]*m/g, '')
      .slice(0, 300) ?? ''
  )
}
