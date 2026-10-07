import { useEffect, useState } from 'react'
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
import type { UtilityModelOption } from '../../../shared/utility-model'

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
  showUsage: DEFAULT_DESKTOP_SETTINGS.showUsage,
  autoTitle: DEFAULT_DESKTOP_SETTINGS.autoTitle,
  utilityModel: DEFAULT_DESKTOP_SETTINGS.utilityModel
}

/** Session titles, commit messages and plugin requests: on or off, and which model writes them. */
function GenerationSettings({ disabled }: { disabled: boolean }): React.JSX.Element {
  const { settings, save } = useDesktopSettings()
  const [models, setModels] = useState<UtilityModelOption[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    window.pi
      .utilityModels()
      .then((list) => {
        if (alive) setModels(list)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [])
  const chosen = settings.utilityModel ?? ''
  const listed = models?.some((model) => `${model.providerId}/${model.modelId}` === chosen)
  return (
    <SettingsGroup title={t('自动生成')}>
      <SettingsRow
        label={t('自动命名会话')}
        description={t('新会话的第一轮结束后，根据你的问题生成标题；你改过的名称不会被替换。')}
      >
        <Switch
          label={t('自动命名会话')}
          checked={settings.autoTitle}
          disabled={disabled}
          onChange={(autoTitle) => void save({ autoTitle })}
        />
      </SettingsRow>
      <SettingsRow
        label={t('生成用的模型')}
        description={
          failed
            ? t('暂时无法读取 Pi 的模型列表。')
            : t(
                '用于会话标题、提交信息和插件的生成请求，使用 Pi 的账号与 API。自动时先试 Haiku、GPT mini、Gemini Flash 等小模型，再用当前会话的模型。'
              )
        }
      >
        <SelectControl
          label={t('生成用的模型')}
          value={chosen}
          disabled={disabled}
          onChange={(value) => void save({ utilityModel: value || null })}
        >
          <option value="">{t('自动')}</option>
          {chosen && !listed ? <option value={chosen}>{chosen}</option> : null}
          {(models ?? []).map((model) => (
            <option
              key={`${model.providerId}/${model.modelId}`}
              value={`${model.providerId}/${model.modelId}`}
            >
              {`${model.name} · ${model.providerId}`}
            </option>
          ))}
        </SelectControl>
      </SettingsRow>
    </SettingsGroup>
  )
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
          {/* i18n-ignore: each language is named in itself */}
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
      <GenerationSettings disabled={disabled} />
      <AppUpdateSettings />
      <DiagnosticsSettings />
      <PreferencesFooter resetPatch={generalDefaults} />
    </SettingsPage>
  )
}
