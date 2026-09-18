import { useNavigationDialog } from './useNavigationDialog'
import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArchiveRestore, Folder, MessageSquare, Search, X } from 'lucide-react'
import { useNavigationLibrary } from '../../store/navigation-library'
import { performNavigationAction } from '../../store/navigation-feedback'

export default function LibraryManager({ onClose }: { onClose: () => void }): React.JSX.Element {
  const opener = useNavigationDialog()
  const library = useNavigationLibrary((state) => state.library)
  const pending = useNavigationLibrary((state) => state.pending > 0)
  const error = useNavigationLibrary((state) => state.error)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'projects' | 'sessions'>('projects')
  const projects = Object.entries(library.projects).filter(
    ([, value]) => value.hiddenAt !== undefined
  )
  const sessions = Object.entries(library.sessions).filter(
    ([, value]) => value.archivedAt !== undefined
  )
  const term = query.trim().toLocaleLowerCase()
  const items =
    tab === 'projects'
      ? projects.map(([path, value]) => ({
          path,
          cwd: path,
          title: value.name || path.split(/[\\/]/).filter(Boolean).at(-1) || path
        }))
      : sessions.map(([path, value]) => ({
          path,
          cwd: value.cwd,
          title: value.title || '历史会话'
        }))
  const matching = items.filter((item) =>
    `${item.title} ${item.cwd}`.toLocaleLowerCase().includes(term)
  )
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="navigation-overlay" />
        <Dialog.Content
          className="navigation-dialog library-manager"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const target = opener.current?.isConnected
              ? opener.current
              : document.querySelector<HTMLElement>('.sidebar-global-search, .rail-top button')
            target?.focus({ preventScroll: true })
          }}
        >
          <div className="navigation-dialog-heading">
            <Dialog.Title>管理项目与归档</Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="关闭管理">
              <X size={18} />
            </Dialog.Close>
          </div>
          <Dialog.Description>
            这里仅管理导航入口。本地项目文件和 Pi 会话记录始终保留。
          </Dialog.Description>
          <div className="library-tabs" role="group" aria-label="选择管理范围">
            <button aria-pressed={tab === 'projects'} onClick={() => setTab('projects')}>
              已移除的项目 <span>{projects.length}</span>
            </button>
            <button aria-pressed={tab === 'sessions'} onClick={() => setTab('sessions')}>
              已归档的会话 <span>{sessions.length}</span>
            </button>
          </div>
          <label className="library-search">
            <Search size={16} />
            <input
              aria-label="搜索已移除或已归档的项目"
              placeholder="按名称或路径筛选…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="navigation-error">
              {error}
            </p>
          )}
          <div className="library-list">
            {matching.map((item) => (
              <div className="library-item" key={item.path}>
                {tab === 'projects' ? <Folder size={18} /> : <MessageSquare size={18} />}
                <span>
                  <strong>{item.title}</strong>
                  <small title={item.cwd}>{item.cwd}</small>
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={pending}
                  aria-label={`恢复 ${item.title}`}
                  onClick={() => {
                    void performNavigationAction(
                      tab === 'projects'
                        ? { type: 'project:restore', cwd: item.cwd }
                        : {
                            type: 'session:archive',
                            cwd: item.cwd,
                            path: item.path,
                            title: item.title,
                            archived: false
                          },
                      tab === 'projects'
                        ? '已恢复项目，可从侧栏重新打开'
                        : '已取消归档，可从项目列表或搜索重新打开'
                    )
                  }}
                >
                  <ArchiveRestore size={14} />
                  恢复
                </button>
              </div>
            ))}
            {!matching.length && (
              <div className="library-empty">
                <ArchiveRestore size={28} />
                <strong>
                  {term
                    ? '没有匹配的记录'
                    : tab === 'projects'
                      ? '没有已移除的项目'
                      : '没有已归档的会话'}
                </strong>
                <p>
                  {term ? '换一个名称或路径试试。' : '移除项目或归档会话后，可以随时在这里恢复。'}
                </p>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
