import { realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { t } from '../shared/i18n'

export function canonicalExistingTempDirectory(
  value: string | undefined,
  name: string,
  tempRoot = tmpdir()
): string {
  if (!value || !isAbsolute(value)) throw new Error(t('{name} 必须是绝对路径', { name }))

  let canonicalValue: string
  let canonicalTempRoot: string
  try {
    canonicalValue = realpathSync(value)
    canonicalTempRoot = realpathSync(tempRoot)
  } catch {
    throw new Error(t('{name} 必须指向已存在的系统临时目录', { name }))
  }
  if (!statSync(canonicalValue).isDirectory()) throw new Error(t('{name} 必须指向目录', { name }))

  const tempRootStats = statSync(canonicalTempRoot)
  if (typeof process.getuid === 'function' && tempRootStats.uid !== process.getuid()) {
    throw new Error(t('{name} 的临时根目录必须属于当前用户', { name }))
  }
  if (process.platform !== 'win32' && (tempRootStats.mode & 0o077) !== 0) {
    throw new Error(t('{name} 的临时根目录权限必须为私有', { name }))
  }

  const relativeToTemp = relative(canonicalTempRoot, canonicalValue)
  if (!relativeToTemp || relativeToTemp.startsWith('..') || isAbsolute(relativeToTemp)) {
    throw new Error(t('{name} 必须位于系统临时目录中，且不能通过符号链接逃逸', { name }))
  }
  return canonicalValue
}

export function assertE2EModeAllowed(e2eMode: boolean, isPackaged: boolean): void {
  if (e2eMode && isPackaged) {
    throw new Error(t('拒绝在已打包的生产应用中启用 PI_DESKTOP_E2E'))
  }
}

export function resolveAgentDirectory(options: {
  e2eMode: boolean
  override?: string
  homeDirectory?: string
  tempRoot?: string
}): string {
  if (!options.e2eMode) return join(options.homeDirectory ?? homedir(), '.pi', 'agent')
  return canonicalExistingTempDirectory(
    options.override,
    'PI_DESKTOP_E2E_AGENT_DIR',
    options.tempRoot
  )
}
