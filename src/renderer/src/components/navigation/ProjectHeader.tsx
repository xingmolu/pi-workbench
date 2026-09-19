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
  const metadataReason = pending || updating ? '正在处理操作，请稍候' : null
  const removeReason =
    metadataReason ?? operationReason ?? (busy ? '请先处理此项目中运行或待确认的任务' : null)
  const act = performNavigationAction
  return (
    <>
      <RowMenu
        className="project-group-head"
        label={`${project.name} 项目操作`}
        actions={[
          { id: 'new', label: '新建会话', icon: Plus, reason: blocked, run: onNew },
          {
            id: 'rename',
            label: '修改显示名称',
            icon: Pencil,
            reason: metadataReason,
            run: () => setRenaming(true)
          },
          {
            id: 'pin',
            label: pref?.pinnedAt === undefined ? '置顶项目' : '取消置顶',
            icon: pref?.pinnedAt === undefined ? Pin : PinOff,
            reason: metadataReason,
            run: () => {
              void act(
                { type: 'project:pin', cwd: project.path, pinned: pref?.pinnedAt === undefined },
                pref?.pinnedAt === undefined ? '已置顶项目' : '已取消置顶'
              )
            }
          },
          {
            id: 'reveal',
            label: '在文件管理器中打开',
            icon: FolderOpen,
            separator: true,
            reason: project.error ? '项目目录不可用' : null,
            run: () => {
              void act({ type: 'project:reveal', cwd: project.path }, '已打开项目目录')
            }
          },
          {
            id: 'copy',
            label: '复制项目路径',
            icon: Copy,
            run: () => {
              void act({ type: 'project:copy-path', cwd: project.path }, '已复制项目路径')
            }
          },
          hidden
            ? {
                id: 'restore',
                label: '恢复到侧栏',
                icon: RotateCcw,
                separator: true,
                reason: metadataReason,
                run: () => {
                  void act({ type: 'project:restore', cwd: project.path }, '已恢复项目')
                }
              }
            : {
                id: 'hide',
                label: '从侧栏移除',
                icon: MinusCircle,
                separator: true,
                reason: removeReason,
                run: () => {
                  void act(
                    { type: 'project:hide', cwd: project.path },
                    `已移除「${project.name}」的侧栏入口，文件和历史仍保留`,
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
            <Pin size={11} className="project-pin" aria-label="已置顶" />
          )}
          {project.error && (
            <TriangleAlert size={13} className="project-unavailable" aria-label="项目目录不可用" />
          )}
        </button>
        <button
          type="button"
          className="project-new icon-btn"
          title={blocked ?? `在 ${project.name} 中新建会话`}
          aria-label={`在 ${project.name} 中新建会话`}
          disabled={Boolean(blocked)}
          data-navigation-pending={pending || undefined}
          onClick={onNew}
        >
          <Plus size={15} />
        </button>
      </RowMenu>
      {renaming && (
        <NameDialog
          title="修改项目显示名称"
          description="只修改 Pi 中的名称，不会重命名磁盘文件夹。"
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
