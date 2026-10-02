import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  MinusCircle,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  TriangleAlert
} from 'lucide-react'
import type { AgentSnapshot } from '../../../../shared/contracts'
import type { LiveProject } from '../../store/live-projects'
import { projectIsHidden } from '../../../../shared/navigation-library'
import { useNavigationLibrary } from '../../store/navigation-library'
import { performNavigationAction } from '../../store/navigation-feedback'
import RowMenu from './RowMenu'
import NameDialog from './NameDialog'
import { t } from '../../../../shared/i18n'

export default function ProjectHeader({
  project,
  snapshot,
  expanded,
  hint,
  blocked,
  operationReason,
  pending,
  onToggle,
  onNew
}: {
  project: LiveProject
  snapshot: AgentSnapshot
  expanded: boolean
  hint?: string
  operationReason: string | null
  blocked: string | null
  pending: boolean
  onToggle: () => void
  onNew: () => void
}): React.JSX.Element {
  const [renaming, setRenaming] = useState(false)
  const library = useNavigationLibrary((state) => state.library)
  const updating = useNavigationLibrary((state) => state.pending > 0)
  const pref = library.projects[project.path]
  const hidden = projectIsHidden(library, project.path)
  const busy =
    project.sessions.some((session) => ['running', 'awaiting-approval'].includes(session.status)) ||
    (snapshot.project?.path === project.path &&
      (snapshot.busy || snapshot.queuedCount > 0 || snapshot.approvals.length > 0))
  const metadataReason = pending || updating ? t('正在处理操作，请稍候') : null
  const removeReason =
    metadataReason ?? operationReason ?? (busy ? t('请先处理此项目中运行或待确认的任务') : null)
  const act = performNavigationAction
  return (
    <>
      <RowMenu
        className="project-group-head"
        label={t('{name} 项目操作', { name: project.name })}
        actions={[
          { id: 'new', label: t('新建会话'), icon: Plus, reason: blocked, run: onNew },
          {
            id: 'rename',
            label: t('修改显示名称'),
            icon: Pencil,
            reason: metadataReason,
            run: () => setRenaming(true)
          },
          {
            id: 'pin',
            label: pref?.pinnedAt === undefined ? t('置顶项目') : t('取消置顶'),
            icon: pref?.pinnedAt === undefined ? Pin : PinOff,
            reason: metadataReason,
            run: () => {
              void act(
                { type: 'project:pin', cwd: project.path, pinned: pref?.pinnedAt === undefined },
                pref?.pinnedAt === undefined ? t('已置顶项目') : t('已取消置顶')
              )
            }
          },
          {
            id: 'reveal',
            label: t('在文件管理器中打开'),
            icon: FolderOpen,
            separator: true,
            reason: project.error ? t('项目目录不可用') : null,
            run: () => {
              void act({ type: 'project:reveal', cwd: project.path }, t('已打开项目目录'))
            }
          },
          {
            id: 'copy',
            label: t('复制项目路径'),
            icon: Copy,
            run: () => {
              void act({ type: 'project:copy-path', cwd: project.path }, t('已复制项目路径'))
            }
          },
          hidden
            ? {
                id: 'restore',
                label: t('恢复到侧栏'),
                icon: RotateCcw,
                separator: true,
                reason: metadataReason,
                run: () => {
                  void act({ type: 'project:restore', cwd: project.path }, t('已恢复项目'))
                }
              }
            : {
                id: 'hide',
                label: t('从侧栏移除'),
                icon: MinusCircle,
                separator: true,
                reason: removeReason,
                run: () => {
                  void act(
                    { type: 'project:hide', cwd: project.path },
                    t('已移除「{name}」的侧栏入口，文件和历史仍保留', { name: project.name }),
                    { type: 'project:restore', cwd: project.path }
                  )
                }
              }
        ]}
      >
        <button
          type="button"
          className="project-group-toggle"
          title={project.path}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Folder size={15} />
          <span className="project-name">{project.name}</span>
          {hint && <small className="project-name-hint">{hint}</small>}
          {pref?.pinnedAt !== undefined && (
            <Pin size={11} className="project-pin" aria-label={t('已置顶')} />
          )}
          {project.error && (
            <TriangleAlert
              size={13}
              className="project-unavailable"
              aria-label={t('项目目录不可用')}
            />
          )}
        </button>
        <button
          type="button"
          className="project-new icon-btn"
          title={blocked ?? t('在 {name} 中新建会话', { name: project.name })}
          aria-label={t('在 {name} 中新建会话', { name: project.name })}
          disabled={Boolean(blocked)}
          data-navigation-pending={(pending && !project.error && !operationReason) || undefined}
          onClick={onNew}
        >
          <Plus size={15} />
        </button>
      </RowMenu>
      {renaming && (
        <NameDialog
          title={t('修改项目显示名称')}
          description={t('只修改 Pi 中的名称，不会重命名磁盘文件夹。')}
          initialValue={pref?.name ?? project.name}
          allowEmpty
          onClose={() => setRenaming(false)}
          onSave={(name) =>
            useNavigationLibrary
              .getState()
              .dispatch({ type: 'project:rename', cwd: project.path, name })
          }
        />
      )}
    </>
  )
}
