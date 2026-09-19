import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type NativeComputerUseCommand =
  | { action: 'accessibility-permission'; prompt: boolean }
  | { action: 'session-lock' }
  | { action: 'ax-dump' }
  | { action: 'move'; x: number; y: number }
  | { action: 'click'; x: number; y: number; button: 'left' | 'right' }
  | { action: 'type'; text: string }

export type NativeComputerUseExec = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number; maxBuffer?: number; signal?: AbortSignal }
) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>

export function defaultNativeComputerUseExec(): NativeComputerUseExec {
  return (file, args, options) => execFileAsync(file, [...args], options)
}

function stdoutText(value: string | Buffer): string {
  return typeof value === 'string' ? value : value.toString('utf8')
}

export class MacComputerUseBridge {
  constructor(
    private readonly helperPath: string,
    private readonly exec: NativeComputerUseExec = defaultNativeComputerUseExec()
  ) {}

  async call(command: NativeComputerUseCommand, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new Error('Computer Use 操作已停止')
    const { stdout } = await this.exec(this.helperPath, [JSON.stringify(command)], {
      timeout: 8000,
      maxBuffer: 512 * 1024,
      ...(signal ? { signal } : {})
    })
    const text = stdoutText(stdout).trim()
    if (!text) throw new Error('Native Computer Use helper 未返回结果')
    return JSON.parse(text) as unknown
  }
}
