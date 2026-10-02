import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DesktopWindowTarget } from '../shared/desktop-control'
import { t } from '../shared/i18n'

const execFileAsync = promisify(execFile)

export type NativeComputerUseCommand =
  | { action: 'accessibility-permission'; prompt: boolean }
  | { action: 'session-lock' }
  | { action: 'ax-dump' }
  | { action: 'foreground-window' }
  | {
      action: 'validate-target'
      x: number
      y: number
      expectedTarget: DesktopWindowTarget
      expiresAt?: number
    }
  | {
      action: 'move'
      x: number
      y: number
      expectedTarget?: DesktopWindowTarget
      expiresAt?: number
    }
  | {
      action: 'click'
      x: number
      y: number
      button: 'left' | 'right'
      expectedTarget?: DesktopWindowTarget
      expiresAt?: number
    }
  | { action: 'type'; text: string; expectedTarget?: DesktopWindowTarget; expiresAt?: number }
  | { action: 'key'; key: string; expectedTarget?: DesktopWindowTarget; expiresAt?: number }
  | { action: 'activate-target'; expectedTarget: DesktopWindowTarget }
  | { action: 'activate-app'; app: string }

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
    if (signal?.aborted) throw new Error(t('Computer Use 操作已停止'))
    let stdout: string | Buffer
    try {
      const result = await this.exec(this.helperPath, [JSON.stringify(command)], {
        timeout: 8000,
        maxBuffer: 512 * 1024,
        ...(signal ? { signal } : {})
      })
      stdout = result.stdout
    } catch (error) {
      signal?.throwIfAborted()
      const failure = error as { code?: string; killed?: boolean; stdout?: string | Buffer }
      try {
        const native = JSON.parse(stdoutText(failure.stdout ?? '').trim()) as { error?: string }
        if (native.error === 'target-changed') {
          throw new Error(t('目标窗口已变化，请重新 observe'))
        }
        if (native.error === 'target-occluded') {
          throw new Error(t('目标窗口被其他窗口遮挡，请重新 observe'))
        }
        if (native.error === 'visual-state-expired') {
          throw new Error(t('视觉 Computer Use 状态已过期，请重新 observe'))
        }
      } catch (parsed) {
        if (
          parsed instanceof Error &&
          /目标窗口已变化|目标窗口被其他窗口遮挡|视觉 Computer Use 状态已过期/.test(parsed.message)
        )
          throw parsed
      }
      const message =
        failure?.code === 'ENOENT'
          ? t(
              'Computer Use 原生助手缺失。源码运行请执行 npm run build:native:mac；安装版请重新安装完整应用。'
            )
          : failure?.code === 'EACCES'
            ? t('Computer Use 原生助手不可执行，请重新构建或安装完整应用。')
            : failure?.killed
              ? t('Computer Use 原生助手调用超时，请重试。')
              : t('Computer Use 原生助手执行失败，请检查应用安装与系统权限。')
      throw new Error(message, { cause: error })
    }
    const text = stdoutText(stdout).trim()
    if (!text) throw new Error(t('Native Computer Use helper 未返回结果'))
    try {
      return JSON.parse(text) as unknown
    } catch (error) {
      throw new Error(t('Computer Use 原生助手返回格式无效，请重新构建或安装完整应用。'), {
        cause: error
      })
    }
  }
}
