import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { format } from 'node:util'
import { t } from '../shared/i18n'

const MAX_BYTES = 1024 * 1024

export type CrashRecord = {
  at: string
  /** `renderer`, `utility` (engine and plugin hosts), `gpu`… */
  kind: string
  reason: string
  exitCode?: number
  name?: string
}

/** Removes keys, tokens and the home directory from text that may leave the machine. */
export function redact(text: string, home = homedir()): string {
  let out = text
    .replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{8,})/g, 'sk-…')
    .replace(/\b(github_pat_|gh[pousr]_)[A-Za-z0-9_]{8,}/g, '$1…')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 …')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '<jwt>')
    .replace(
      /("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi,
      '$1"…"'
    )
  if (home && home.length > 1) out = out.split(home).join('~')
  return out
}

/**
 * Local diagnostics: the main process's warnings and errors in `main.log`, and processes that
 * went away unexpectedly in `crashes.jsonl`, both under the app's log directory with one
 * rotation each. Nothing is uploaded; Settings can export a redacted summary.
 */
export class Diagnostics {
  constructor(private readonly directory: string) {}

  get logFile(): string {
    return join(this.directory, 'main.log')
  }

  get crashFile(): string {
    return join(this.directory, 'crashes.jsonl')
  }

  log(level: 'warn' | 'error', args: unknown[]): void {
    this.append(this.logFile, `${new Date().toISOString()} ${level} ${redact(format(...args))}\n`)
  }

  crash(record: Omit<CrashRecord, 'at'>): void {
    const entry: CrashRecord = { at: new Date().toISOString(), ...record }
    this.append(this.crashFile, `${JSON.stringify(entry)}\n`)
    this.log('error', [`process gone: ${record.kind} ${record.name ?? ''} ${record.reason}`])
  }

  /** Keeps console output and also writes warnings and errors to the log file. */
  capture(target: Pick<Console, 'warn' | 'error'>): void {
    for (const level of ['warn', 'error'] as const) {
      const original = target[level].bind(target)
      target[level] = (...args: unknown[]) => {
        original(...args)
        this.log(level, args)
      }
    }
  }

  crashes(sinceMs = 7 * 24 * 60 * 60 * 1000): CrashRecord[] {
    const since = Date.now() - sinceMs
    return this.lines(this.crashFile)
      .map((line) => {
        try {
          return JSON.parse(line) as CrashRecord
        } catch {
          return null
        }
      })
      .filter((entry): entry is CrashRecord => !!entry && Date.parse(entry.at) >= since)
  }

  /** A plain-text report a user can attach to a bug report. */
  report(facts: Record<string, unknown>, lines = 1500): string {
    const crashes = this.crashes()
    const log = this.lines(this.logFile).slice(-lines)
    return redact(
      [
        t('# Pi Desktop 诊断信息'),
        '',
        t('## 环境'),
        ...Object.entries(facts).map(
          ([key, value]) => `- ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
        ),
        '',
        t('## 最近 7 天进程意外退出（{length}）', { length: crashes.length }),
        ...(crashes.length
          ? crashes.map(
              (entry) =>
                `- ${entry.at} ${entry.kind}${entry.name ? ` (${entry.name})` : ''}: ${entry.reason}${entry.exitCode !== undefined ? ` exit ${entry.exitCode}` : ''}`
            )
          : [t('- 无')]),
        '',
        t('## 主进程日志（最后 {length} 行）', { length: log.length }),
        '```',
        ...log,
        '```',
        ''
      ].join('\n')
    )
  }

  private lines(file: string): string[] {
    const read = (path: string): string => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return ''
      }
    }
    return (read(`${file}.1`) + read(file)).split('\n').filter(Boolean)
  }

  private append(file: string, text: string): void {
    try {
      mkdirSync(this.directory, { recursive: true })
      try {
        if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
      } catch {
        /* First write. */
      }
      appendFileSync(file, text, { mode: 0o600 })
    } catch {
      /* Diagnostics must never break what they describe. */
    }
  }
}
