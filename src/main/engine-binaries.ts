import { createHash, randomBytes } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  type WriteStream
} from 'node:fs'
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { createGunzip } from 'node:zlib'
import { ENGINE_BINARY_PINS } from '../shared/engine-binaries.generated'
import type { DownloadableEngine, EngineBinaryStatus } from '../shared/engine-binaries'

type Pin = {
  tarball: string
  integrity: string
  size: number
  /** Prefix inside the tarball that becomes the install directory. */
  root: string
  /** Executable relative to the install directory. */
  executable: string
  /** Paths under `root` that are not extracted. */
  skip?: readonly string[]
}

export type EngineBinariesOptions = {
  /** Where downloaded engines live, one `<engine>/<version>/` directory each. */
  root: string
  platform?: NodeJS.Platform
  arch?: string
  /** Electron's `net.fetch` in the app so system proxies apply. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  /** Pause between automatic retries of an interrupted download. */
  retryDelayMs?: number
  /** An engine shipped with a development checkout, used when nothing was downloaded. */
  bundled?: (engine: DownloadableEngine) => string | undefined
  /** An explicit executable from the environment wins over everything. */
  override?: (engine: DownloadableEngine) => string | undefined
  pins?: Record<DownloadableEngine, { version: string; platforms: Record<string, Pin> }>
  onChange?: () => void
}

const COMPLETE = '.pi-desktop-complete'
const ATTEMPTS = 3

/**
 * Engine CLIs are large (100–330 MB each), so the installer ships none of them. The first time
 * an engine is used its official npm build for this platform is downloaded, checked against the
 * sha512 pinned in this repository, and unpacked into the app's data directory.
 */
export class EngineBinaries {
  private readonly progress = new Map<DownloadableEngine, { received: number }>()
  private readonly errors = new Map<DownloadableEngine, string>()
  private readonly installs = new Map<DownloadableEngine, Promise<void>>()
  private readonly pins: NonNullable<EngineBinariesOptions['pins']>

  constructor(private readonly options: EngineBinariesOptions) {
    this.pins = options.pins ?? (ENGINE_BINARY_PINS as unknown as typeof this.pins)
  }

  private platformKey(): string {
    return `${this.options.platform ?? process.platform}-${this.options.arch ?? process.arch}`
  }

  private pin(engine: DownloadableEngine): Pin | undefined {
    return this.pins[engine].platforms[this.platformKey()]
  }

  private directory(engine: DownloadableEngine): string {
    return join(this.options.root, engine, this.pins[engine].version)
  }

  private downloaded(engine: DownloadableEngine): string | undefined {
    const pin = this.pin(engine)
    if (!pin) return undefined
    const directory = this.directory(engine)
    const executable = join(directory, pin.executable)
    return existsSync(join(directory, COMPLETE)) && existsSync(executable) ? executable : undefined
  }

  /**
   * A complete download of another version. After an app update pins a newer CLI, the old one
   * keeps working until the user updates, instead of the engine disappearing.
   */
  private previous(
    engine: DownloadableEngine
  ): { version: string; executable: string } | undefined {
    const pin = this.pin(engine)
    if (!pin) return undefined
    const parent = join(this.options.root, engine)
    let entries: string[]
    try {
      entries = readdirSync(parent)
    } catch {
      return undefined
    }
    for (const version of entries.sort().reverse()) {
      if (version.startsWith('.') || version === this.pins[engine].version) continue
      const executable = join(parent, version, pin.executable)
      if (existsSync(join(parent, version, COMPLETE)) && existsSync(executable))
        return { version, executable }
    }
    return undefined
  }

  /** The executable to run, or undefined when the engine still has to be downloaded. */
  executable(engine: DownloadableEngine): string | undefined {
    return (
      this.options.override?.(engine) ??
      this.downloaded(engine) ??
      this.previous(engine)?.executable ??
      this.options.bundled?.(engine)
    )
  }

  status(engine: DownloadableEngine): EngineBinaryStatus {
    const pin = this.pin(engine)
    const base = { runtimeId: engine, version: this.pins[engine].version, size: pin?.size ?? 0 }
    if (this.options.override?.(engine)) return { ...base, state: 'ready', source: 'override' }
    if (this.downloaded(engine)) return { ...base, state: 'ready', source: 'downloaded' }
    const progress = this.progress.get(engine)
    if (progress) return { ...base, state: 'downloading', received: progress.received }
    const previous = this.previous(engine)
    if (previous)
      return { ...base, state: 'ready', source: 'downloaded', outdated: previous.version }
    if (this.options.bundled?.(engine)) return { ...base, state: 'ready', source: 'bundled' }
    if (!pin) return { ...base, state: 'unsupported' }
    const error = this.errors.get(engine)
    return error ? { ...base, state: 'error', error } : { ...base, state: 'missing' }
  }

  /** Downloads and unpacks the engine once; concurrent callers share the same download. */
  install(engine: DownloadableEngine): Promise<void> {
    const running = this.installs.get(engine)
    if (running) return running
    const install = this.download(engine).finally(() => {
      this.installs.delete(engine)
      this.progress.delete(engine)
      this.options.onChange?.()
    })
    this.installs.set(engine, install)
    return install
  }

  /** Removes downloaded builds; a bundled build, if any, takes over again. */
  async remove(engine: DownloadableEngine): Promise<void> {
    if (this.installs.has(engine)) throw new Error('正在下载，请稍后再试')
    await rm(join(this.options.root, engine), { recursive: true, force: true })
    this.errors.delete(engine)
    this.options.onChange?.()
  }

  private async download(engine: DownloadableEngine): Promise<void> {
    const pin = this.pin(engine)
    if (!pin) throw new Error('这个引擎没有适用于当前系统的版本')
    this.errors.delete(engine)
    this.progress.set(engine, { received: 0 })
    this.options.onChange?.()
    const parent = join(this.options.root, engine)
    await mkdir(parent, { recursive: true })
    const version = this.pins[engine].version
    // The archive lands next to the install first, so an interrupted download resumes.
    const part = join(parent, `.download-${version}.tgz.part`)
    const staging = join(parent, `.staging-${randomBytes(6).toString('hex')}`)
    try {
      await this.fetchArchive(engine, pin, part)
      const [algorithm, expected] = pin.integrity.split('-', 2) as [string, string]
      const hash = createHash(algorithm)
      for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer)
      if (hash.digest('base64') !== expected) {
        await rm(part, { force: true })
        throw new Error('下载内容校验失败，已丢弃')
      }
      // Nothing is unpacked before the archive matches the pinned digest.
      await mkdir(staging, { recursive: true })
      const gunzip = createGunzip()
      const source = createReadStream(part)
      source.on('error', (error) => gunzip.destroy(error))
      source.pipe(gunzip)
      const extractor = new TarExtractor(staging, pin.root, pin.skip ?? [])
      for await (const chunk of gunzip) await extractor.push(chunk as Buffer)
      await extractor.end()
      const executable = join(staging, pin.executable)
      if (!existsSync(executable)) throw new Error('下载的包里没有找到引擎程序')
      await chmod(executable, 0o755)
      await writeFile(join(staging, COMPLETE), new Date().toISOString())
      const target = this.directory(engine)
      await rm(target, { recursive: true, force: true })
      await rename(staging, target)
      await rm(part, { force: true })
      // Older versions are dead weight once the pinned one is in place.
      for (const entry of await readdir(parent))
        if (entry !== version && !entry.startsWith('.download-'))
          await rm(join(parent, entry), { recursive: true, force: true })
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      const message = error instanceof Error ? error.message : String(error)
      this.errors.set(engine, message)
      throw new Error(message)
    }
  }

  /** Fetches the archive into `part`, resuming with HTTP ranges across up to three attempts. */
  private async fetchArchive(engine: DownloadableEngine, pin: Pin, part: string): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const have = await stat(part).then(
        (info) => info.size,
        () => 0
      )
      if (pin.size && have === pin.size) return
      this.progress.set(engine, { received: have })
      this.options.onChange?.()
      try {
        const response = await this.options.fetch(
          pin.tarball,
          have ? { headers: { range: `bytes=${have}-` } } : undefined
        )
        const resumed = have > 0 && response.status === 206
        if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）`)
        const output = createWriteStream(part, { flags: resumed ? 'a' : 'w' })
        let received = resumed ? have : 0
        let lastReport = received
        try {
          // Read the web stream directly so every byte received before a drop reaches the disk.
          const reader = response.body.getReader()
          for (;;) {
            const { done, value: chunk } = await reader.read()
            if (done) break
            if (!output.write(chunk)) await once(output, 'drain')
            received += chunk.length
            this.progress.set(engine, { received })
            if (received - lastReport > 1024 * 1024) {
              lastReport = received
              this.options.onChange?.()
            }
          }
        } finally {
          output.end()
          await once(output, 'close').catch(() => undefined)
        }
        return
      } catch (error) {
        lastError = error
        // Server errors and digest failures are not helped by retrying; network drops are.
        if (error instanceof Error && error.message.startsWith('下载失败（HTTP 4')) break
        await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs ?? 1000))
      }
    }
    if (lastError instanceof Error && lastError.message.startsWith('下载失败')) throw lastError
    throw lastError instanceof Error
      ? new Error(`下载中断：${lastError.message}，可以点「重试」从断点继续`)
      : new Error('下载中断，可以点「重试」从断点继续')
  }
}

/** Just enough of ustar (with pax and GNU long names) to unpack an npm tarball safely. */
export class TarExtractor {
  private buffer: Buffer = Buffer.alloc(0)
  private file: { stream: WriteStream | null; remaining: number; padding: number } | null = null
  private longName: string | null = null
  private done = false

  constructor(
    private readonly target: string,
    private readonly root: string,
    private readonly skip: readonly string[]
  ) {}

  async push(chunk: Buffer): Promise<void> {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (!this.done) {
      if (this.file) {
        if (this.file.remaining > 0) {
          if (!this.buffer.length) return
          const take = Math.min(this.file.remaining, this.buffer.length)
          const slice = this.buffer.subarray(0, take)
          this.buffer = this.buffer.subarray(take)
          this.file.remaining -= take
          if (this.file.stream && !this.file.stream.write(slice))
            await once(this.file.stream, 'drain')
          continue
        }
        if (this.buffer.length < this.file.padding) return
        this.buffer = this.buffer.subarray(this.file.padding)
        const stream = this.file.stream
        this.file = null
        if (stream) {
          stream.end()
          await once(stream, 'finish')
        }
        continue
      }
      if (this.buffer.length < 512) return
      const header = this.buffer.subarray(0, 512)
      if (header.every((byte) => byte === 0)) {
        this.done = true
        return
      }
      // Metadata entries (pax, GNU long names) are read whole before going on.
      const type = String.fromCharCode(header[156] ?? 48)
      if (type === 'x' || type === 'L') {
        const size = parseInt(
          header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0',
          8
        )
        const total = 512 + size + ((512 - (size % 512)) % 512)
        if (this.buffer.length < total) return
        const value = this.buffer.subarray(512, 512 + size).toString('utf8')
        this.buffer = this.buffer.subarray(total)
        if (type === 'L') this.longName = value.replace(/\0.*$/s, '')
        else {
          const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(value)?.[1]
          if (path) this.longName = path
        }
        continue
      }
      this.buffer = this.buffer.subarray(512)
      await this.entry(header)
    }
  }

  async end(): Promise<void> {
    if (this.file?.stream) this.file.stream.destroy()
    if (this.file && this.file.remaining > 0) throw new Error('下载的压缩包不完整')
  }

  private async entry(header: Buffer): Promise<void> {
    const text = (start: number, length: number): string =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '')
    const size = parseInt(text(124, 12).trim() || '0', 8)
    const mode = parseInt(text(100, 8).trim() || '644', 8)
    const type = text(156, 1) || '0'
    const prefix = text(345, 155)
    let name = this.longName ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100))
    this.longName = null
    const padding = (512 - (size % 512)) % 512
    name = name.replace(/^\.\//, '')
    const relative = name.startsWith(this.root) ? name.slice(this.root.length) : null
    const wanted =
      type === '0' &&
      relative !== null &&
      relative !== '' &&
      !this.skip.some((skipped) => relative.startsWith(skipped))
    let stream: WriteStream | null = null
    if (wanted) {
      const path = normalize(join(this.target, relative))
      if (isAbsolute(relative) || !path.startsWith(this.target + sep))
        throw new Error('压缩包里有越界路径，已拒绝')
      await mkdir(join(path, '..'), { recursive: true })
      stream = createWriteStream(path, { mode: mode & 0o111 ? 0o755 : 0o644 })
    }
    this.file = { stream, remaining: size, padding }
  }
}
