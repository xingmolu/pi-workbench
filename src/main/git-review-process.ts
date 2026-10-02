import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { isAbsolute } from 'node:path'

export interface GitProcessRequest {
  cwd: string
  args: readonly string[]
  budget: 'status' | 'patch'
  signal?: AbortSignal
}
export type GitProcessResult =
  | { ok: true; stdout: Buffer }
  | {
      ok: false
      reason:
        | 'exit'
        | 'signal'
        | 'spawn'
        | 'io'
        | 'timeout'
        | 'aborted'
        | 'stdout-limit'
        | 'stderr-limit'
        | 'queue-full'
        | 'invalid-request'
      exitCode?: number
      signal?: NodeJS.Signals
      systemCode?: string
      stderrKind?: 'not-repository' | 'other'
    }
export interface GitProcessOptions {
  gitPath: string
  /** Main supplies an existing, host-owned empty directory; never a project path. */
  hooksPath: string
  /** Values supplied by trusted Main startup, not renderer/project environment. */
  trustedEnv: NodeJS.ProcessEnv
  spawn?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess
}

/** Main-only substrate. This general runner must never be exposed over IPC. */
export class GitReviewProcess {
  private readonly execute: NonNullable<GitProcessOptions['spawn']>
  private readonly env: NodeJS.ProcessEnv = {}
  private active = 0
  private readonly queue: Array<() => void> = []
  constructor(private readonly options: GitProcessOptions) {
    if (!isAbsolute(options.gitPath) || !isAbsolute(options.hooksPath))
      throw new Error('Git host paths must be absolute')
    this.options = { ...options }
    this.execute = options.spawn ?? spawn
    for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot', 'TEMP', 'TMP']) {
      if (options.trustedEnv[key] !== undefined) this.env[key] = options.trustedEnv[key]
    }
    // Review behavior must depend on repository state, not whichever machine-level
    // Git/LFS helpers happen to be installed on the host. Repository-local config
    // (and includes reached from it) remains visible, so project-declared filters
    // are still detected and rejected before a scan can execute them.
    this.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
    this.env.GIT_CONFIG_NOSYSTEM = '1'
    this.env.GIT_ATTR_NOSYSTEM = '1'
    this.env.GIT_TERMINAL_PROMPT = '0'
    this.env.GIT_NO_LAZY_FETCH = '1'
  }
  run(request: GitProcessRequest): Promise<GitProcessResult> {
    if (
      !isAbsolute(request.cwd) ||
      request.cwd.length > 32768 ||
      request.cwd.includes('\0') ||
      request.args.length > 128 ||
      request.args.some((arg) => arg.includes('\0')) ||
      request.args.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > 65536 ||
      !['status', 'patch'].includes(request.budget)
    )
      return Promise.resolve({ ok: false, reason: 'invalid-request' })
    if (request.signal?.aborted) return Promise.resolve({ ok: false, reason: 'aborted' })
    if (this.active >= 2 && this.queue.length >= 16)
      return Promise.resolve({ ok: false, reason: 'queue-full' })
    // Copy before queueing: callers cannot mutate an admitted command or signal.
    request = { ...request, args: [...request.args] }
    return new Promise((resolve) => {
      let child: ChildProcess | undefined
      let started = false
      let finished = false
      let killRequested = false
      let failure: Extract<GitProcessResult, { ok: false }> | undefined
      let stdout: Buffer | undefined
      let stderr: Buffer | undefined
      let outSize = 0
      let errSize = 0
      const outCap = request.budget === 'status' ? 4 * 1024 * 1024 : 2 * 1024 * 1024
      const finish = (result: GitProcessResult): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', abort)
        const queuedIndex = this.queue.indexOf(start)
        if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1)
        child?.stdout?.removeListener('data', onOut)
        child?.stderr?.removeListener('data', onErr)
        child?.stdout?.removeListener('error', onIOError)
        child?.stderr?.removeListener('error', onIOError)
        child?.removeListener('error', onError)
        child?.removeListener('close', onClose)
        stdout = undefined
        stderr = undefined
        if (started) this.active--
        resolve(result)
        while (this.active < 2 && this.queue.length) this.queue.shift()!()
      }
      const kill = (): void => {
        if (!child || killRequested) return
        killRequested = true
        // Node emits close after spawn errors as well. Keep the slot until close;
        // a kill error must not throw from an output/abort/timer event handler.
        try {
          child.kill('SIGKILL')
        } catch {
          /* The original failure remains authoritative. */
        }
      }
      const stop = (reason: Extract<GitProcessResult, { ok: false }>['reason']): void => {
        if (failure || finished) return
        failure = { ok: false, reason }
        if (child) kill()
        else finish(failure)
      }
      const abort = (): void => stop('aborted')
      const onOut = (chunk: Buffer): void => {
        if (failure || finished) return
        if (outSize + chunk.length > outCap) {
          stop('stdout-limit')
          return
        }
        chunk.copy(stdout!, outSize)
        outSize += chunk.length
      }
      const onErr = (chunk: Buffer): void => {
        if (failure || finished) return
        if (errSize + chunk.length > 65536) {
          stop('stderr-limit')
          return
        }
        chunk.copy(stderr!, errSize)
        errSize += chunk.length
      }
      const onIOError = (): void => stop('io')
      const onError = (error: NodeJS.ErrnoException): void => {
        // Never retain error.message, spawnargs, cwd, environment or raw stderr.
        if (!failure)
          failure = {
            ok: false,
            reason: 'spawn',
            ...(['ENOENT', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'ENOMEM', 'EAGAIN'].includes(
              error.code ?? ''
            )
              ? { systemCode: error.code }
              : {})
          }
        kill()
      }
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (failure) finish(failure)
        else if (signal) finish({ ok: false, reason: 'signal', signal })
        else if (code !== 0)
          finish({
            ok: false,
            reason: 'exit',
            ...(code !== null ? { exitCode: code } : {}),
            stderrKind: stderr!
              .subarray(0, errSize)
              .includes(Buffer.from('fatal: not a git repository'))
              ? 'not-repository'
              : 'other'
          })
        else finish({ ok: true, stdout: Buffer.from(stdout!.subarray(0, outSize)) })
      }
      const start = (): void => {
        started = true
        this.active++
        stdout = Buffer.allocUnsafe(outCap)
        stderr = Buffer.allocUnsafe(65536)
        try {
          child = this.execute(
            this.options.gitPath,
            [
              '--no-pager',
              '--no-optional-locks',
              '--literal-pathspecs',
              '-c',
              'core.fsmonitor=false',
              '-c',
              `core.hooksPath=${this.options.hooksPath}`,
              '-c',
              'color.ui=false',
              ...request.args
            ],
            {
              cwd: request.cwd,
              shell: false,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...this.env }
            }
          )
        } catch (error) {
          onError(error as NodeJS.ErrnoException)
          finish(failure!)
          return
        }
        child.on('error', onError)
        child.once('close', onClose)
        child.stdout?.on('data', onOut)
        child.stderr?.on('data', onErr)
        child.stdout?.on('error', onIOError)
        child.stderr?.on('error', onIOError)
        if (!child.stdout || !child.stderr) stop('io')
      }
      // The whole request, including queue time, has a deadline.
      const timer = setTimeout(() => stop('timeout'), request.budget === 'status' ? 5000 : 10000)
      request.signal?.addEventListener('abort', abort, { once: true })
      if (this.active < 2) start()
      else this.queue.push(start)
    })
  }
}
