import { useEffect, useRef, useState } from 'react'
import type { GitReviewEntry, GitReviewResult, GitReviewView } from '../../../shared/git-review'
import GitPatchView from './GitPatchView'

type Inventory = Extract<GitReviewResult, { type: 'list' }>
type Patch = Extract<GitReviewResult, { type: 'patch' }>
const modes: [GitReviewView, string, string][] = [
  ['unstaged', '未暂存', '暂存区 → 工作区'],
  ['staged', '已暂存', 'HEAD → 暂存区（首次提交前也可查看）'],
  ['branch', '分支', '所选基准与 HEAD 的共同祖先 → HEAD · 仅已提交内容']
]
const statusLabels: Record<string, string> = {
  M: '修改',
  A: '新增',
  D: '删除',
  T: '类型变化',
  U: '冲突',
  '?': '未跟踪'
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请刷新重试'
}

export default function GitReviewPane({
  projectPath,
  ready
}: {
  projectPath: string | null
  ready: boolean
}): React.JSX.Element {
  const [view, setView] = useState<GitReviewView>('unstaged')
  const [baseRef, setBaseRef] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [refs, setRefs] = useState<{ name: string; label: string }[]>([])
  const [refsError, setRefsError] = useState('')
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [listError, setListError] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<GitReviewEntry | null>(null)
  const [patch, setPatch] = useState<Patch | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [patchError, setPatchError] = useState('')
  const [patchLoading, setPatchLoading] = useState(false)
  const epoch = useRef(0)

  const clearSelection = (): void => {
    epoch.current++
    setSelected(null)
    setPatch(null)
    setPreview(null)
    setPatchError('')
    setPatchLoading(false)
  }
  const invalidate = (): void => {
    clearSelection()
    setInventory(null)
    setListError('')
  }

  useEffect(() => {
    let active = true
    setRefs([])
    setRefsError('')
    if (projectPath && ready) {
      void window.pi
        .gitReview({ type: 'refs', projectPath })
        .then((result) => {
          if (!active) return
          if (result.type === 'refs') setRefs(result.refs)
          else setRefsError(result.type === 'unavailable' ? result.message : '无法读取比较基准')
        })
        .catch((error) => {
          if (active) setRefsError(errorText(error))
        })
    }
    return () => {
      active = false
    }
  }, [projectPath, ready, refresh])

  useEffect(() => {
    let active = true
    clearSelection()
    setInventory(null)
    setListError('')
    setLoading(false)
    if (projectPath && ready) {
      setLoading(true)
      void window.pi
        .gitReview({
          type: 'list',
          projectPath,
          view,
          ...(view === 'branch' && baseRef ? { baseRef } : {})
        })
        .then((result) => {
          if (!active) return
          if (result.type === 'list') setInventory(result)
          else
            setListError(result.type === 'unavailable' ? result.message : '无法读取 Git 文件清单')
        })
        .catch((error) => {
          if (active) setListError(errorText(error))
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }
    return () => {
      active = false
      epoch.current++
    }
  }, [projectPath, ready, view, baseRef, refresh])

  const selectFile = async (entry: GitReviewEntry): Promise<void> => {
    const request = ++epoch.current
    setSelected(entry)
    setPatch(null)
    setPreview(null)
    setPatchError('')
    setPatchLoading(true)
    try {
      if (!projectPath || !inventory || !ready) return
      if (entry.kind === 'untracked') {
        if (!entry.previewPath)
          throw new Error(entry.previewUnavailable ?? '此路径暂不支持只读预览')
        const result = await window.pi.workspaceFiles({
          type: 'read',
          projectPath,
          path: entry.previewPath
        })
        if (request !== epoch.current) return
        if (result.type !== 'read') throw new Error('无法读取未跟踪文件')
        setPreview(result.text)
      } else {
        const result = await window.pi.gitReview({
          type: 'patch',
          projectPath,
          reviewId: inventory.reviewId,
          entryId: entry.entryId
        })
        if (request !== epoch.current) return
        if (result.type !== 'patch')
          throw new Error(result.type === 'unavailable' ? result.message : '无法读取文件差异')
        if (result.reviewId !== inventory.reviewId || result.entryId !== entry.entryId)
          throw new Error('差异身份不匹配，请刷新重试')
        setPatch(result)
      }
    } catch (error) {
      if (request === epoch.current) setPatchError(errorText(error))
    } finally {
      if (request === epoch.current) setPatchLoading(false)
    }
  }

  return (
    <section className="git-review-pane" aria-label="Git 审阅">
      {!projectPath ? (
        <p className="git-message">选择工作区以查看 Git 差异</p>
      ) : !ready ? (
        <p className="git-message" role="status">
          引擎已断开，重新连接后可查看 Git 差异
        </p>
      ) : (
        <>
          <div className="git-toolbar">
            <span className="git-readonly">只读</span>
            <button
              type="button"
              onClick={() => {
                invalidate()
                setRefresh((value) => value + 1)
              }}
            >
              刷新差异
            </button>
          </div>
          <div className="git-modes" aria-label="差异范围">
            {modes.map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view === mode}
                onClick={() => {
                  if (view !== mode) {
                    invalidate()
                    setView(mode)
                  }
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="git-baseline">{modes.find(([mode]) => mode === view)?.[2]}</p>
          {view === 'branch' && (
            <div className="git-base-select">
              <label htmlFor="git-base-ref">比较基准</label>
              <select
                id="git-base-ref"
                value={baseRef}
                onChange={(event) => {
                  invalidate()
                  setBaseRef(event.target.value)
                }}
              >
                <option value="">请选择基准分支</option>
                {refs.map((ref) => (
                  <option key={ref.name} value={ref.name}>
                    {ref.name.startsWith('refs/heads/') ? '本地' : '远端引用'} · {ref.label}
                  </option>
                ))}
              </select>
              {refsError && <p role="alert">{refsError}</p>}
            </div>
          )}
          {inventory?.branch && (
            <p
              className="git-baseline"
              title={`共同祖先 ${inventory.branch.mergeBaseOid}\nHEAD ${inventory.branch.headOid}`}
            >
              共同祖先 {inventory.branch.mergeBaseOid.slice(0, 8)} → HEAD{' '}
              {inventory.branch.headOid.slice(0, 8)}
            </p>
          )}
          {loading && (
            <p className="git-message" role="status">
              正在读取 Git 差异…
            </p>
          )}
          {listError && (
            <p className="git-message" role="alert">
              {listError}
            </p>
          )}
          {inventory && (
            <>
              {inventory.entries.length === 0 ? (
                <p className="git-message" role="status">
                  此范围没有改动
                </p>
              ) : (
                <div className="git-file-list" aria-label="变更文件">
                  {(['tracked', 'untracked'] as const).map((group) => {
                    const entries = inventory.entries.filter(
                      (entry) => (entry.kind === 'untracked') === (group === 'untracked')
                    )
                    return (
                      entries.length > 0 && (
                        <div key={group}>
                          <h3>
                            {group === 'untracked' ? '未跟踪 · 只读预览' : '已跟踪'}{' '}
                            <span>{entries.length}</span>
                          </h3>
                          {entries.map((entry) => (
                            <button
                              key={entry.entryId}
                              type="button"
                              className="git-file"
                              aria-label={entry.path}
                              aria-pressed={selected?.entryId === entry.entryId}
                              onClick={() => void selectFile(entry)}
                            >
                              <span className="git-file-path" title={entry.path}>
                                {entry.path}
                              </span>
                              <span
                                className="git-file-status"
                                title={`Git ${entry.status} · ${entry.kind}`}
                              >
                                {entry.kind === 'conflict'
                                  ? '冲突'
                                  : entry.kind === 'submodule'
                                    ? '子模块'
                                    : (statusLabels[entry.status] ?? entry.status)}
                              </span>
                            </button>
                          ))}
                        </div>
                      )
                    )
                  })}
                </div>
              )}
              {selected ? (
                <div className="git-selection">
                  <h3 className="git-selected-path" title={selected.path}>
                    {selected.path}
                  </h3>
                  {patchLoading && (
                    <p className="git-message" role="status">
                      正在读取文件差异…
                    </p>
                  )}
                  {patchError && (
                    <p className="git-message" role="alert">
                      {patchError}
                    </p>
                  )}
                  {preview !== null && (
                    <div className="git-patch">
                      <p className="git-message">未跟踪文件 · 只读内容预览，不属于已跟踪差异</p>
                      <pre tabIndex={0} aria-label="未跟踪文件内容">
                        {preview}
                      </pre>
                    </div>
                  )}
                  {patch && <GitPatchView patch={patch} />}
                </div>
              ) : (
                inventory.entries.length > 0 && <p className="git-message">选择文件查看差异</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
