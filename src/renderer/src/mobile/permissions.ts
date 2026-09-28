import { Hand, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { PermissionMode } from '../../../shared/contracts'

export const PERMISSION_LEVELS = [
  {
    mode: 'ask',
    icon: Hand,
    title: '请求批准',
    description: '写文件、运行命令和网页操作前都会询问'
  },
  {
    mode: 'auto',
    icon: ShieldCheck,
    title: '帮我批准',
    description: '自动批准项目内可撤销的编辑和常规命令，其余仍会询问'
  },
  {
    mode: 'open',
    icon: ShieldAlert,
    title: '完全访问权限',
    description: '不再询问，可运行任何命令、访问项目外文件和网络'
  }
] as const

export function permissionTitle(mode: PermissionMode | undefined): string {
  return PERMISSION_LEVELS.find((level) => level.mode === mode)?.title ?? '请求批准'
}
