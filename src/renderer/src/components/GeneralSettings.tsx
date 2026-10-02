import { useState } from 'react'
import { DEFAULT_DESKTOP_SETTINGS, type DesktopSettings } from '../../../shared/desktop-settings'
import { useDesktopSettings } from '../store/desktop-settings'
import {
  Segmented,
  SelectControl,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsStatus,
  Switch
} from './SettingsPrimitives'
import '../assets/desktop-settings.css'
import AppUpdateSettings from './AppUpdateSettings'
import DiagnosticsSettings from './DiagnosticsSettings'
import { t } from '../../../shared/i18n'

/** Status line and "restore defaults" for a page of desktop preferences. */
export function PreferencesFooter({
  resetPatch
}: {
  resetPatch: Partial<DesktopSettings>
}): React.JSX.Element {
  const { status, error, hydrate, save } = useDesktopSettings()
  return (
    <div className="sp-footer">
      <SettingsStatus status={status} error={error} onRetry={() => void hydrate()} />
      <button
        type="button"
        className="sp-link-button"
        disabled={status !== 'ready'}
        onClick={() => void save(resetPatch)}
      >
        {t('恢复默认')}
      </button>
    </div>
  )
}

const generalDefaults: Partial<DesktopSettings> = {
  sendShortcut: DEFAULT_DESKTOP_SETTINGS.sendShortcut,
  workDetails: DEFAULT_DESKTOP_SETTINGS.workDetails,
  showUsage: DEFAULT_DESKTOP_SETTINGS.showUsage
}

/** The language picker; each language is named in itself so it can be found from either one. */
function LanguageSettings(): React.JSX.Element {
  const { settings, save, status } = useDesktopSettings()
  const [changed, setChanged] = useState(false)
  return (
    <SettingsGroup title={t('语言')}>
      <SettingsRow
        label={t('界面语言')}
        description={
          changed
            ? t('重启 Pi Desktop 后生效。')
            : t('跟随系统时，中文系统显示中文，其他语言显示英文。')
        }
      >
        <SelectControl
          label={t('界面语言')}
          value={settings.language}
          disabled={status !== 'ready'}
          onChange={(value) => {
            setChanged(true)
            void save({ language: value as DesktopSettings['language'] })
          }}
        >
          <option value="system">{t('跟随系统')}</option>
          <option value="zh-CN">中文</option>
          <option value="en">English</option>
        </SelectControl>
        {changed ? (
          <button type="button" className="acct-button" onClick={() => void window.pi.relaunch()}>
            {t('立即重启')}
          </button>
        ) : null}
      </SettingsRow>
    </SettingsGroup>
  )
}

export default function GeneralSettings(): React.JSX.Element {
  const { settings, save, status } = useDesktopSettings()
  const disabled = status !== 'ready'
  return (
    <SettingsPage title={t('常规')}>
      <LanguageSettings />
      <SettingsGroup title={t('输入')}>
        <SettingsRow
          label={t('发送快捷键')}
          description={t('Shift + Enter 始终换行；输入法选词时不会发送。')}
        >
          <SelectControl
            label={t('发送快捷键')}
            value={settings.sendShortcut}
            disabled={disabled}
            onChange={(value) =>
              void save({ sendShortcut: value as DesktopSettings['sendShortcut'] })
            }
          >
            <option value="enter">{t('Enter 发送')}</option>
            <option value="modifier-enter">{t('⌘ / Ctrl + Enter 发送')}</option>
          </SelectControl>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t('对话')}>
        <SettingsRow
          label={t('工作详情')}
          description={t('工作过程默认展开还是收起；单独展开过的保持你的选择。')}
        >
          <Segmented
            label={t('工作详情')}
            value={settings.workDetails}
            disabled={disabled}
            options={[
              { value: 'compact', label: t('紧凑') },
              { value: 'expanded', label: t('展开') }
            ]}
            onChange={(workDetails) => void save({ workDetails })}
          />
        </SettingsRow>
        <SettingsRow label={t('显示用量统计')} description={t('在输入框下方显示本次会话的用量。')}>
          <Switch
            label={t('显示用量统计')}
            checked={settings.showUsage}
            disabled={disabled}
            onChange={(showUsage) => void save({ showUsage })}
          />
        </SettingsRow>
      </SettingsGroup>
      <AppUpdateSettings />
      <DiagnosticsSettings />
      <PreferencesFooter resetPatch={generalDefaults} />
    </SettingsPage>
  )
}
