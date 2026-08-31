export type WorkbenchMode = 'files' | 'review' | 'terminal' | 'browser'

const MODES: { id: WorkbenchMode; label: string }[] = [
  { id: 'files', label: '文件' },
  { id: 'review', label: '审查' },
  { id: 'terminal', label: '终端' },
  { id: 'browser', label: '浏览器' }
]

const MODE_HINT: Record<WorkbenchMode, string> = {
  files: '工作区树与预览会显示在这里。',
  review: 'Git 工作台：Last turn 与 Working tree。',
  terminal: '用户 PTY。Agent 的 bash 仍走对话卡片。',
  browser: '内嵌 Chromium，独立 profile。'
}

type WorkbenchProps = {
  collapsed: boolean
  mode: WorkbenchMode
  onModeChange: (mode: WorkbenchMode) => void
  onToggle: () => void
}

export default function Workbench({
  collapsed,
  mode,
  onModeChange,
  onToggle
}: WorkbenchProps): React.JSX.Element {
  return (
    <aside className={`workbench${collapsed ? ' is-collapsed' : ''}`}>
      <div className="workbench-picker">
        {MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === mode ? 'is-active' : undefined}
            onClick={() => onModeChange(item.id)}
          >
            {item.label}
          </button>
        ))}
        <button className="icon-btn fold" type="button" onClick={onToggle} title="折叠工作台">
          {collapsed ? '‹' : '›'}
        </button>
      </div>

      {!collapsed && (
        <div className="workbench-body">
          <p className="workbench-empty-title">选一个工作区</p>
          <p className="workbench-empty-copy">{MODE_HINT[mode]}</p>
        </div>
      )}
    </aside>
  )
}
