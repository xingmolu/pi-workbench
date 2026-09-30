import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  KeyRound,
  Monitor,
  Palette,
  Puzzle,
  Search,
  Server,
  Settings,
  Smartphone,
  Sparkles,
  X
} from 'lucide-react'
import RuntimeSettings from './RuntimeSettings'
import GeneralSettings from './GeneralSettings'
import AppearanceSettings from './AppearanceSettings'
import MobileGatewaySettings from './MobileGatewaySettings'
import DesktopControlSettings from './DesktopControlSettings'
import type {
  AgentSnapshot,
  LoginMethod,
  WorkbenchCommand,
  WorkbenchSnapshot
} from '../../../shared/contracts'
import SettingsAccounts from './SettingsAccounts'
import PluginSettings from './PluginSettings'
import { SettingsPage } from './SettingsPrimitives'
import {
  SettingsDraftProvider,
  confirmDiscardSettingsDraft,
  useSettingsDraftController
} from './SettingsDraftContext'
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
  skillsContent?: ReactNode
  renderAccountQuota?: (account: AgentSnapshot['accounts'][number]) => ReactNode
}

const sections = [
  { id: 'runtimes', label: 'Agent 引擎', group: '基础设置', icon: Puzzle, keywords: 'runtime 运行时 claude pi sdk 历史 导入' },
  {
    id: 'general',
    label: '常规',
    group: '基础设置',
    icon: Settings,
    keywords: '发送 快捷键 工作详情 用量 enter'
  },
  {
    id: 'appearance',
    label: '外观',
    group: '基础设置',
    icon: Palette,
    keywords: '主题 深色 浅色 系统 字号 代码 换行 动效'
  },
  {
    id: 'mobile',
    label: '手机',
    group: '连接',
    icon: Smartphone,
    keywords: '远程 配对 二维码 tailscale gateway'
  },
  {
    id: 'accounts',
    label: '账号与模型',
    group: '连接',
    icon: KeyRound,
    keywords: 'openai codex anthropic api key 自定义端点 登录 模型'
  },
  {
    id: 'skills',
    label: 'Skills 技能',
    group: 'Agent 能力',
    icon: Sparkles,
    keywords: 'skill 技能 agent'
  },
  {
    id: 'mcp',
    label: 'MCP 服务器',
    group: 'Agent 能力',
    icon: Server,
    keywords: 'mcp server 工具 本地命令 http'
  },
  {
    id: 'plugins',
    label: 'Desktop 插件',
    group: 'Agent 能力',
    icon: Puzzle,
    keywords: 'plugin 插件 desktop workbench'
  },
  {
    id: 'desktop-control',
    label: '桌面控制',
    group: 'Agent 能力',
    icon: Monitor,
    keywords: 'computer use 屏幕录制 辅助功能 点击 capture accessibility'
  }
] as const

type SettingsSection = (typeof sections)[number]['id']

export default function SettingsDialog(props: SettingsDialogProps): React.JSX.Element {
  return (
    <SettingsDraftProvider>
      <SettingsDialogContent {...props} />
    </SettingsDraftProvider>
  )
}

function SettingsDialogContent({
  open,
  returnFocusRef,
  onOpenChange,
  mcpContent,
  skillsContent,
  ...props
}: SettingsDialogProps): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>('accounts')
  const [query, setQuery] = useState('')
  const draft = useSettingsDraftController()

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const visibleSections = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return sections
    return sections.filter((item) =>
      (item.label + ' ' + item.group + ' ' + item.keywords).toLocaleLowerCase().includes(needle)
    )
  }, [query])

  const discardDraft = (): boolean => {
    if (!confirmDiscardSettingsDraft(Boolean(draft?.dirty))) return false
    draft?.clear()
    return true
  }

  const chooseSection = (next: SettingsSection): void => {
    if (next === section) return
    if (!discardDraft()) return
    setSection(next)
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen && !discardDraft()) return
    onOpenChange(nextOpen)
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="settings-overlay" />
        <Dialog.Content
          className="settings-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            returnFocusRef.current?.focus()
          }}
        >
          <Dialog.Close className="icon-btn settings-close" aria-label="关闭设置" title="关闭设置">
            <X size={17} />
          </Dialog.Close>
          <Dialog.Description className="settings-sr-only">
            管理 Pi Desktop 的常规、外观、账号、Agent 能力与桌面控制设置。
          </Dialog.Description>
          <div className="settings-dialog-body">
            <nav className="settings-navigation" aria-label="设置分类">
              <div className="settings-dialog-title">
                <Dialog.Title>设置</Dialog.Title>
                {draft?.dirty ? <span className="settings-unsaved-badge">未保存</span> : null}
              </div>
              <label className="settings-search">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  value={query}
                  aria-label="搜索设置"
                  placeholder="搜索设置"
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query ? (
                  <button
                    type="button"
                    className="settings-search-clear"
                    aria-label="清空设置搜索"
                    onClick={() => setQuery('')}
                  >
                    <X size={13} />
                  </button>
                ) : null}
              </label>
              <div className="settings-navigation-list">
                {visibleSections.map(({ id, label, group, icon: Icon }, index) => {
                  const previous = visibleSections[index - 1]
                  return (
                    <div key={id}>
                      {!previous || previous.group !== group ? (
                        <p className="settings-group-label">{group}</p>
                      ) : null}
                      <button
                        type="button"
                        aria-current={section === id ? 'page' : undefined}
                        onClick={() => chooseSection(id)}
                      >
                        <Icon size={15} />
                        <span>{label}</span>
                        {draft?.dirty && section === id ? (
                          <span className="settings-unsaved-dot" title="有未保存修改" />
                        ) : null}
                      </button>
                    </div>
                  )
                })}
                {visibleSections.length === 0 ? (
                  <p className="settings-search-empty">没有匹配的设置</p>
                ) : null}
              </div>
              <small className="settings-product-name">Pi Desktop</small>
            </nav>
            <div className="settings-content" data-settings-section={section}>
              <div className="settings-content-inner">
                {section === 'runtimes' ? <RuntimeSettings /> : section === 'general' ? (
                  <GeneralSettings />
                ) : section === 'appearance' ? (
                  <AppearanceSettings />
                ) : section === 'mobile' ? (
                  <MobileGatewaySettings />
                ) : section === 'accounts' ? (
                  <SettingsPage
                    title="账号与模型"
                    description="登录编程套餐或添加自定义端点；凭据只保存在本机。"
                  >
                    <SettingsAccounts {...props} />
                  </SettingsPage>
                ) : section === 'skills' ? (
                  (skillsContent ?? <p className="inline-hint">技能设置模块尚未加载。</p>)
                ) : section === 'plugins' ? (
                  <PluginSettings
                    snapshot={props.workbenchSnapshot}
                    onCommand={props.onWorkbenchCommand}
                  />
                ) : section === 'desktop-control' ? (
                  <DesktopControlSettings />
                ) : (
                  (mcpContent ?? <p className="inline-hint">MCP 设置模块尚未加载。</p>)
                )}
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
