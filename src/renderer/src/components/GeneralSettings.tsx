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
        恢复默认
      </button>
    </div>
  )
}

const generalDefaults: Partial<DesktopSettings> = {
  sendShortcut: DEFAULT_DESKTOP_SETTINGS.sendShortcut,
  workDetails: DEFAULT_DESKTOP_SETTINGS.workDetails,
  showUsage: DEFAULT_DESKTOP_SETTINGS.showUsage
}

export default function GeneralSettings(): React.JSX.Element {
  const { settings, save, status } = useDesktopSettings()
  const disabled = status !== 'ready'
  return (
    <SettingsPage title="常规">
      <SettingsGroup title="输入">
        <SettingsRow
          label="发送快捷键"
          description="Shift + Enter 始终换行；输入法选词时不会发送。"
        >
          <SelectControl
            label="发送快捷键"
            value={settings.sendShortcut}
            disabled={disabled}
            onChange={(value) =>
              void save({ sendShortcut: value as DesktopSettings['sendShortcut'] })
            }
          >
            <option value="enter">Enter 发送</option>
            <option value="modifier-enter">⌘ / Ctrl + Enter 发送</option>
          </SelectControl>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="对话">
        <SettingsRow
          label="工作详情"
          description="工作过程默认展开还是收起；单独展开过的保持你的选择。"
        >
          <Segmented
            label="工作详情"
            value={settings.workDetails}
            disabled={disabled}
            options={[
              { value: 'compact', label: '紧凑' },
              { value: 'expanded', label: '展开' }
            ]}
            onChange={(workDetails) => void save({ workDetails })}
          />
        </SettingsRow>
        <SettingsRow label="显示用量统计" description="在输入框下方显示本次会话的用量。">
          <Switch
            label="显示用量统计"
            checked={settings.showUsage}
            disabled={disabled}
            onChange={(showUsage) => void save({ showUsage })}
          />
        </SettingsRow>
      </SettingsGroup>
      <AppUpdateSettings />
      <PreferencesFooter resetPatch={generalDefaults} />
    </SettingsPage>
  )
}
