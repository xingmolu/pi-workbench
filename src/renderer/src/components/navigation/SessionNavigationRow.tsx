import { useState, type ReactNode } from 'react'
import { Archive, ArchiveRestore, Pencil, Pin, PinOff } from 'lucide-react'
import type { LiveSessionRow } from '../../store/live-projects'
import { useNavigationLibrary } from '../../store/navigation-library'
import { performNavigationAction } from '../../store/navigation-feedback'
import RowMenu from './RowMenu'
import NameDialog from './NameDialog'
import { t } from '../../../../shared/i18n'

export default function SessionNavigationRow({
  cwd,
  session,
  blocked,
  children
}: {
  cwd: string
  session: LiveSessionRow
  blocked: string | null
  children: ReactNode
}): React.JSX.Element {
  const [renaming, setRenaming] = useState(false)
  const library = useNavigationLibrary((state) => state.library)
  const updating = useNavigationLibrary((state) => state.pending > 0)
  const pref = session.path ? library.sessions[session.path] : undefined
  const archived = pref?.archivedAt !== undefined
  const metadataReason = !session.path
    ? t('会话保存后可操作')
    : updating
      ? t('正在处理操作，请稍候')
      : null
  const mutationReason =
    metadataReason ??
    blocked ??
    (['running', 'awaiting-approval'].includes(session.status)
      ? t('请先停止运行或处理待确认操作')
      : null)
  const archiveReason =
    mutationReason ?? (session.sessionTask ? t('后台子任务请从父任务管理') : null)
  return (
    <>
      <RowMenu
        className={`project-session-item${session.active ? ' is-active' : ''}${pref?.pinnedAt !== undefined ? ' is-pinned' : ''}`}
        label={t('{title} 会话操作', { title: session.title })}
        actions={[
          {
            id: 'rename',
            label: t('重命名会话'),
            icon: Pencil,
            reason: mutationReason,
            run: () => setRenaming(true)
          },
          {
            id: 'pin',
            label: pref?.pinnedAt === undefined ? t('置顶会话') : t('取消置顶'),
            icon: pref?.pinnedAt === undefined ? Pin : PinOff,
            reason: metadataReason,
            run: () => {
              void performNavigationAction(
                {
                  type: 'session:pin',
                  cwd,
                  path: session.path!,
                  title: session.title,
                  pinned: pref?.pinnedAt === undefined
                },
                pref?.pinnedAt === undefined ? t('已置顶会话') : t('已取消置顶')
              )
            }
          },
          {
            id: 'archive',
            label: archived ? t('取消归档') : t('归档会话'),
            icon: archived ? ArchiveRestore : Archive,
            separator: true,
            reason: archived ? metadataReason : archiveReason,
            run: () => {
              void performNavigationAction(
                {
                  type: 'session:archive',
                  cwd,
                  path: session.path!,
                  title: session.title,
                  archived: !archived
                },
                archived ? t('已恢复会话') : t('会话已归档，历史记录仍保留'),
                {
                  type: 'session:archive',
                  cwd,
                  path: session.path!,
                  title: session.title,
                  archived
                }
              )
            }
          }
        ]}
      >
        {children}
      </RowMenu>
      {renaming && (
        <NameDialog
          title={t('重命名会话')}
          description={t('名称将保存到原会话记录，不会切换当前会话或修改对话内容。')}
          initialValue={session.title}
          onClose={() => setRenaming(false)}
          onSave={(name) =>
            useNavigationLibrary
              .getState()
              .dispatch({ type: 'session:rename', cwd, path: session.path!, name })
          }
        />
      )}
    </>
  )
}
