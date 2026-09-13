import { useState, type ReactNode, type RefObject } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { KeyRound, Puzzle, Server, X } from 'lucide-react'
import type {
  AgentSnapshot,
  LoginMethod,
  WorkbenchCommand,
  WorkbenchSnapshot
} from '../../../shared/contracts'
import SettingsAccounts from './SettingsAccounts'
import PluginSettings from './PluginSettings'
import '../assets/settings.css'

export type SettingsDialogProps = {
  open: boolean
  returnFocusRef: RefObject<HTMLElement | null>
  onOpenChange: (open: boolean) => void
  agentSnapshot: AgentSnapshot
  workbenchSnapshot: WorkbenchSnapshot
  onWorkbenchCommand: (command: WorkbenchCommand) => Promise<void>
  onLogin: (providerId: string, method: LoginMethod) => void
  onAddAlias: (slug: string) => void
  onLoginPrompt: (promptId: string, value?: string) => void
  mcpContent?: ReactNode
  renderAccountQuota?: (account: AgentSnapshot['accounts'][number]) => ReactNode
}

export default function SettingsDialog({
  open,
  returnFocusRef,
  onOpenChange,
  mcpContent,
  ...props
}: SettingsDialogProps): React.JSX.Element {
  const [section, setSection] = useState('accounts')
  const sections = [
    { id: 'accounts', label: '账号与模型', icon: KeyRound },
    { id: 'mcp', label: 'MCP 服务器', icon: Server },
    { id: 'plugins', label: 'Desktop 插件', icon: Puzzle }
  ]
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="settings-overlay" />
        <Dialog.Content
          className="settings-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            returnFocusRef.current?.focus()
          }}
        >
          <header className="settings-dialog-header">
            <Dialog.Title>设置</Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="关闭设置" title="关闭设置">
              <X size={18} />
            </Dialog.Close>
          </header>
          <Dialog.Description className="settings-sr-only">
            管理 Pi 账号、模型端点、MCP 服务器与 Desktop 插件。
          </Dialog.Description>
          <div className="settings-dialog-body">
            <nav className="settings-navigation" aria-label="设置分类">
              {sections.map(({ id, label, icon: Icon }) => (
                <div key={id}>
                  <button
                    type="button"
                    key={id}
                    aria-current={section === id ? 'page' : undefined}
                    onClick={() => setSection(id)}
                  >
                    <Icon size={16} />
                    {label}
                  </button>
                </div>
              ))}
              <small>Pi Desktop</small>
            </nav>
            <div className="settings-content">
              {section === 'accounts' ? (
                <SettingsAccounts {...props} />
              ) : section === 'plugins' ? (
                <PluginSettings
                  snapshot={props.workbenchSnapshot}
                  onCommand={props.onWorkbenchCommand}
                />
              ) : (
                (mcpContent ?? <p className="inline-hint">MCP 设置模块尚未加载。</p>)
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
