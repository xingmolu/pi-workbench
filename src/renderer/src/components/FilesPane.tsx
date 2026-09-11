import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, File, Folder, Link2 } from 'lucide-react'
import type { WorkspaceFileEntry, WorkspaceFilesResult } from '../../../shared/workspace-files'
import { stageTextFile, useTextAttachments } from '../store/text-attachments'

type Listing = Extract<WorkspaceFilesResult, { type: 'list' | 'search' }>
type ReadResult = Extract<WorkspaceFilesResult, { type: 'read' }>
type Load<T> = { value?: T; error?: string }
const message = (error: unknown): string =>
  (error instanceof Error ? error.message : '无法读取，请重试').replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    ''
  )

function ListingStatus({
  state,
  empty
}: {
  state: Load<Listing>
  empty: string
}): React.JSX.Element {
  return (
    <>
      {state.error ? (
        <p className="files-message is-error" role="alert">
          {state.error}。可刷新重试。
        </p>
      ) : !state.value ? (
        <p className="files-message" role="status">
          正在读取文件列表…
        </p>
      ) : !state.value.entries.length ? (
        <p className="files-message" role="status">
          {empty}
        </p>
      ) : null}
      {state.value?.truncated ? (
        <p className="files-message files-warning" role="status">
          仅显示部分结果，已达到扫描或数量上限。请缩小范围。
        </p>
      ) : null}
    </>
  )
}

type DirectoryProps = {
  projectPath: string
  path: string
  includeHidden: boolean
  revision: number
  onSelect: (path: string) => void
}

function FileButton({
  entry,
  onSelect,
  fullPath = false
}: {
  entry: WorkspaceFileEntry
  onSelect: (path: string) => void
  fullPath?: boolean
}): React.JSX.Element {
  const unavailable = entry.kind !== 'file'
  const Icon = unavailable ? Link2 : File
  return (
    <button
      type="button"
      className="files-entry"
      disabled={unavailable}
      title={entry.path}
      onClick={() => onSelect(entry.path)}
    >
      <Icon size={14} aria-hidden="true" />
      <span>{fullPath ? entry.path : entry.name}</span>
      {unavailable ? (
        <small>{entry.kind === 'symlink' ? '符号链接 · 不可用' : '不支持'}</small>
      ) : null}
    </button>
  )
}

function Directory(props: DirectoryProps): React.JSX.Element {
  const { projectPath, path, includeHidden, revision, onSelect } = props
  const [state, setState] = useState<Load<Listing>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    let active = true
    setState({})
    void window.pi.workspaceFiles({ type: 'list', projectPath, path, includeHidden }).then(
      (result) => {
        if (active && result.type === 'list') setState({ value: result })
      },
      (error) => {
        if (active) setState({ error: message(error) })
      }
    )
    return () => {
      active = false
    }
  }, [projectPath, path, includeHidden, revision])
  return (
    <>
      <ListingStatus state={state} empty={path ? '空目录' : '项目目录为空'} />
      <ul className="files-list">
        {state.value?.entries.map((entry) => (
          <li key={entry.path}>
            {entry.kind === 'directory' ? (
              <>
                <button
                  type="button"
                  className="files-entry"
                  aria-expanded={expanded.has(entry.path)}
                  title={entry.path}
                  onClick={() =>
                    setExpanded((previous) => {
                      const next = new Set(previous)
                      if (next.has(entry.path)) next.delete(entry.path)
                      else next.add(entry.path)
                      return next
                    })
                  }
                >
                  {expanded.has(entry.path) ? (
                    <ChevronDown size={12} aria-hidden="true" />
                  ) : (
                    <ChevronRight size={12} aria-hidden="true" />
                  )}
                  <Folder size={14} aria-hidden="true" />
                  <span>{entry.name}</span>
                </button>
                {expanded.has(entry.path) ? (
                  <div className="files-nested">
                    <Directory {...props} path={entry.path} />
                  </div>
                ) : null}
              </>
            ) : (
              <FileButton entry={entry} onSelect={onSelect} />
            )}
          </li>
        ))}
      </ul>
    </>
  )
}

/** The parent keys this surface by project identity; all pending work is scoped to its mount. */
export default function FilesPane({
  projectPath
}: {
  projectPath: string | null
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const attachments = useTextAttachments()
  const [includeHidden, setIncludeHidden] = useState(false)
  const [revision, setRevision] = useState(0)
  const [search, setSearch] = useState<Load<Listing>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<Load<ReadResult>>({})
  const [wrap, setWrap] = useState(false)
  const [feedback, setFeedback] = useState('')
  const epoch = useRef(0)
  const copyEpoch = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const backButton = useRef<HTMLButtonElement>(null)
  const lastSelection = useRef<string | null>(null)
  const tree = useRef<HTMLDivElement>(null)
  const clearFeedback = (): void => {
    copyEpoch.current++
    clearTimeout(timer.current)
    setFeedback('')
  }
  useEffect(
    () => () => {
      epoch.current++
      copyEpoch.current++
      clearTimeout(timer.current)
    },
    []
  )
  useEffect(() => {
    let active = true
    setSearch({})
    if (!projectPath || !query.trim())
      return () => {
        active = false
      }
    const timeout = setTimeout(() => {
      void window.pi
        .workspaceFiles({ type: 'search', projectPath, query: query.trim(), includeHidden })
        .then(
          (result) => {
            if (active && result.type === 'search') setSearch({ value: result })
          },
          (error) => {
            if (active) setSearch({ error: message(error) })
          }
        )
    }, 180)
    return () => {
      active = false
      clearTimeout(timeout)
    }
  }, [projectPath, query, includeHidden, revision])
  useEffect(() => {
    if (selected) backButton.current?.focus()
    else if (lastSelection.current) {
      const buttons = tree.current?.querySelectorAll<HTMLButtonElement>('button[title]')
      Array.from(buttons ?? [])
        .find(
          (button) => button.title === lastSelection.current && button.getClientRects().length > 0
        )
        ?.focus()
    }
  }, [selected])
  const read = (path: string): void => {
    if (!projectPath) return
    const request = ++epoch.current
    clearFeedback()
    lastSelection.current = path
    setSelected(path)
    setPreview({})
    void window.pi.workspaceFiles({ type: 'read', projectPath, path }).then(
      (result) => {
        if (request === epoch.current && result.type === 'read') setPreview({ value: result })
      },
      (error) => {
        if (request === epoch.current) setPreview({ error: message(error) })
      }
    )
  }
  const copy = async (text: string, label: string): Promise<void> => {
    clearFeedback()
    const request = copyEpoch.current
    try {
      await navigator.clipboard.writeText(text)
      if (request === copyEpoch.current) setFeedback(`已复制${label}`)
    } catch {
      if (request === copyEpoch.current) setFeedback('复制失败，请检查剪贴板权限后重试')
    }
    if (request === copyEpoch.current) timer.current = setTimeout(() => setFeedback(''), 3000)
  }
  return (
    <section className="files-pane" aria-label="项目文件">
      {!projectPath ? (
        <p className="files-message">打开项目后可浏览文件。</p>
      ) : (
        <>
          <div className="files-toolbar">
            <span className="files-project" title={projectPath}>
              {projectPath.split('/').filter(Boolean).at(-1)}
            </span>
            <small>只读</small>
            <button
              type="button"
              onClick={() => {
                setRevision((value) => value + 1)
                if (selected) read(selected)
              }}
            >
              刷新文件
            </button>
          </div>
          <div className="files-browser" hidden={selected !== null} ref={tree}>
            <div className="files-controls">
              <label className="files-search">
                搜索文件名
                <input
                  value={query}
                  maxLength={100}
                  placeholder="按文件名搜索，不搜索内容"
                  onChange={(event) => {
                    setSearch({})
                    setQuery(event.target.value)
                  }}
                />
              </label>
              <label className="files-check">
                <input
                  type="checkbox"
                  checked={includeHidden}
                  onChange={(event) => {
                    setSearch({})
                    setIncludeHidden(event.target.checked)
                  }}
                />
                显示隐藏文件
              </label>
            </div>
            <div className="files-tree" hidden={Boolean(query.trim())}>
              <Directory
                projectPath={projectPath}
                path=""
                includeHidden={includeHidden}
                revision={revision}
                onSelect={read}
              />
            </div>
            {query.trim() ? (
              <div className="files-tree">
                <ListingStatus state={search} empty="没有匹配的文件" />
                {search.value?.entries.map((entry) => (
                  <FileButton key={entry.path} entry={entry} fullPath onSelect={read} />
                ))}
              </div>
            ) : null}
          </div>
          {selected !== null ? (
            <div className="files-preview">
              <div className="files-preview-head">
                <button
                  type="button"
                  ref={backButton}
                  onClick={() => {
                    epoch.current++
                    clearFeedback()
                    setSelected(null)
                    setPreview({})
                  }}
                >
                  返回文件列表
                </button>
                <div className="files-path">{selected}</div>
                <div className="files-actions">
                  <button
                    type="button"
                    disabled={
                      !preview.value ||
                      attachments.staging ||
                      attachments.sending ||
                      Boolean(attachments.submission)
                    }
                    onClick={() => void stageTextFile(selected)}
                  >
                    添加到对话
                  </button>
                  <button type="button" onClick={() => void copy(selected, '相对路径')}>
                    复制相对路径
                  </button>
                  <button
                    type="button"
                    disabled={!preview.value}
                    onClick={() => {
                      if (preview.value) void copy(preview.value.text, '内容')
                    }}
                  >
                    复制内容
                  </button>
                  <label className="files-check">
                    <input
                      type="checkbox"
                      checked={wrap}
                      onChange={(event) => setWrap(event.target.checked)}
                    />
                    自动换行
                  </label>
                </div>
                <div role="status" className="files-feedback">
                  {feedback}
                </div>
              </div>
              {preview.error ? (
                <p role="alert" className="files-message is-error">
                  {preview.error}。可刷新重试或返回文件列表。
                </p>
              ) : preview.value ? (
                <>
                  <small className="files-size">
                    UTF-8 · {preview.value.size.toLocaleString()} 字节 · 只读预览
                  </small>
                  <pre tabIndex={0} className={wrap ? 'is-wrapped' : ''}>
                    {preview.value.text}
                  </pre>
                </>
              ) : (
                <p role="status" className="files-message">
                  正在读取文件…
                </p>
              )}
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
