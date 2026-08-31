type SidebarProps = {
  collapsed: boolean
  onToggle: () => void
  agentReady: boolean
  agentDir: string
}

export default function Sidebar({
  collapsed,
  onToggle,
  agentReady,
  agentDir
}: SidebarProps): React.JSX.Element {
  return (
    <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`}>
      <div className="sidebar-head">
        <button className="icon-btn" type="button" onClick={onToggle} title="收起侧栏">
          {collapsed ? '›' : '‹'}
        </button>
        {!collapsed && (
          <div className="brand">
            <span className="brand-mark">π</span>
            <span className="brand-name">Pi Desktop</span>
          </div>
        )}
      </div>

      {!collapsed && (
        <>
          <button className="new-session" type="button">
            新会话
          </button>

          <div className="sidebar-section">
            <div className="sidebar-label">工作区</div>
            <p className="sidebar-empty">打开一个文件夹作为工作区。Project 即 Pi 的 cwd；会话会挂在文件夹下。</p>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-label">会话</div>
            <p className="sidebar-empty">还没有会话。标题与相对时间会出现在这里。</p>
          </div>

          <div className="sidebar-spacer" />

          <div className="sidebar-host" title={agentDir}>
            <span className={`host-dot${agentReady ? ' is-on' : ''}`} />
            {agentReady ? 'Agent Host 占位已就绪' : 'Agent Host 未连接'}
          </div>

          <div className="sidebar-foot">
            <button type="button">设置</button>
            <button type="button">插件市场</button>
          </div>
        </>
      )}
    </aside>
  )
}
