import { useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import Conversation from './components/Conversation'
import Workbench, { type WorkbenchMode } from './components/Workbench'

export default function App(): React.JSX.Element {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [workbenchCollapsed, setWorkbenchCollapsed] = useState(false)
  const [mode, setMode] = useState<WorkbenchMode>('files')
  const [agentReady, setAgentReady] = useState(false)
  const [agentDir, setAgentDir] = useState('~/.pi/agent')

  useEffect(() => {
    let cancelled = false
    const readStatus = (): void => {
      void window.api
        ?.getAgentHostStatus()
        .then((status) => {
          if (cancelled || !status) return
          setAgentReady(status.ready)
          setAgentDir(status.agentDir)
        })
        .catch(() => {
          /* renderer-only preview has no IPC */
        })
    }
    readStatus()
    const timer = window.setInterval(readStatus, 1500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  return (
    <div className="shell">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((value) => !value)}
        agentReady={agentReady}
        agentDir={agentDir}
      />
      <Conversation />
      <Workbench
        collapsed={workbenchCollapsed}
        mode={mode}
        onModeChange={setMode}
        onToggle={() => setWorkbenchCollapsed((value) => !value)}
      />
    </div>
  )
}
