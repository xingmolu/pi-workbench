import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  ArchiveRestore,
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
import GeneralSettings from './GeneralSettings'
import AppearanceSettings from './AppearanceSettings'
import MobileGatewaySettings from './MobileGatewaySettings'
import DesktopControlSettings from './DesktopControlSettings'
import type { AgentSnapshot, WorkbenchCommand, WorkbenchSnapshot } from '../../../shared/contracts'
import EngineAccounts from './EngineAccounts'
import PluginSettings from './PluginSettings'
import LibrarySettings from './LibrarySettings'
import {
  SettingsDraftProvider,
  confirmDiscardSettingsDraft,
  useSettingsDraftController
} from './SettingsDraftContext'
import { t } from '../../../shared/i18n'
import '../assets/settings.css'

export type SettingsDialogProps = {
  open: boolean
  returnFocusRef: RefObject<HTMLElement | null>
  onOpenChange: (open: boolean) => void
  agentSnapshot: AgentSnapshot
  workbenchSnapshot: WorkbenchSnapshot
  onWorkbenchCommand: (command: WorkbenchCommand) => Promise<void>
  mcpContent?: ReactNode
  skillsContent?: ReactNode
}

const sections = [
  {
    id: 'engines',
    label: t('引擎与账号'),
    group: t('基础设置'),
    icon: KeyRound,
    keywords: t(
      'agent 引擎 runtime claude code pi codex chatgpt 订阅 账号 邮箱 登录 api key 端点 模型 默认 历史 导入'
    )
  },
  {
    id: 'general',
    label: t('常规'),
    group: t('基础设置'),
    icon: Settings,
    keywords: t('发送 快捷键 工作详情 用量 enter')
  },
  {
    id: 'appearance',
    label: t('外观'),
    group: t('基础设置'),
    icon: Palette,
    keywords: t('主题 深色 浅色 系统 字号 代码 换行 动效')
  },
  {
    id: 'library',
    label: t('项目与归档'),
    group: t('基础设置'),
    icon: ArchiveRestore,
    keywords: t('项目 会话 归档 移除 恢复 隐藏 侧栏')
  },
  {
    id: 'mobile',
    label: t('手机'),
    group: t('连接'),
    icon: Smartphone,
    keywords: t('远程 配对 二维码 tailscale gateway')
  },
  {
    id: 'skills',
    label: t('Skills 技能'),
    group: t('Agent 能力'),
    icon: Sparkles,
    keywords: t('skill 技能 agent')
  },
  {
    id: 'mcp',
    label: t('MCP 服务器'),
    group: t('Agent 能力'),
    icon: Server,
    keywords: t('mcp server 工具 本地命令 http')
  },
  {
    id: 'plugins',
    label: t('Desktop 插件'),
    group: t('Agent 能力'),
    icon: Puzzle,
    keywords: t('plugin 插件 desktop workbench')
  },
  {
    id: 'desktop-control',
    label: t('桌面控制'),
    group: t('Agent 能力'),
    icon: Monitor,
    keywords: t('computer use 屏幕录制 辅助功能 点击 capture accessibility')
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
  const [section, setSection] = useState<SettingsSection>('engines')
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
          <Dialog.Close
            className="icon-btn settings-close"
            aria-label={t('关闭设置')}
            title={t('关闭设置')}
          >
            <X size={17} />
          </Dialog.Close>
          <Dialog.Description className="settings-sr-only">
            {t('管理 Pi Desktop 的常规、外观、账号、Agent 能力与桌面控制设置。')}
          </Dialog.Description>
          <div className="settings-dialog-body">
            <nav className="settings-navigation" aria-label={t('设置分类')}>
              <div className="settings-dialog-title">
                <Dialog.Title>{t('设置')}</Dialog.Title>
                {draft?.dirty ? (
                  <span className="settings-unsaved-badge">{t('未保存')}</span>
                ) : null}
              </div>
              <label className="settings-search">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  value={query}
                  aria-label={t('搜索设置')}
                  placeholder={t('搜索设置')}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query ? (
                  <button
                    type="button"
                    className="settings-search-clear"
                    aria-label={t('清空设置搜索')}
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
                          <span className="settings-unsaved-dot" title={t('有未保存修改')} />
                        ) : null}
                      </button>
                    </div>
                  )
                })}
                {visibleSections.length === 0 ? (
                  <p className="settings-search-empty">{t('没有匹配的设置')}</p>
                ) : null}
              </div>
              <small className="settings-product-name">Pi Desktop</small>
            </nav>
            <div className="settings-content" data-settings-section={section}>
              <div className="settings-content-inner">
                {section === 'engines' ? (
                  <EngineAccounts snapshot={props.agentSnapshot} />
                ) : section === 'general' ? (
                  <GeneralSettings />
                ) : section === 'appearance' ? (
                  <AppearanceSettings />
                ) : section === 'library' ? (
                  <LibrarySettings />
                ) : section === 'mobile' ? (
                  <MobileGatewaySettings />
                ) : section === 'skills' ? (
                  (skillsContent ?? <p className="inline-hint">{t('技能设置模块尚未加载。')}</p>)
                ) : section === 'plugins' ? (
                  <PluginSettings
                    snapshot={props.workbenchSnapshot}
                    onCommand={props.onWorkbenchCommand}
                  />
                ) : section === 'desktop-control' ? (
                  <DesktopControlSettings />
                ) : (
                  (mcpContent ?? <p className="inline-hint">{t('MCP 设置模块尚未加载。')}</p>)
                )}
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
