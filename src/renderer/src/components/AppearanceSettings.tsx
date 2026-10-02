import type { CSSProperties } from 'react'
import { DEFAULT_DESKTOP_SETTINGS, type DesktopSettings } from '../../../shared/desktop-settings'
import type { AccentColor } from '../../../shared/theme-tokens'
import type { PluginThemeSummary } from '../../../shared/workbench-contracts'
import { useDesktopSettings } from '../store/desktop-settings'
import { usePluginThemes } from '../store/plugin-themes'
import { PreferencesFooter } from './GeneralSettings'
import { HighlightedCode } from './HighlightedCode'
import {
  SelectControl,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  Switch
} from './SettingsPrimitives'
import { t } from '../../../shared/i18n'

const appearanceDefaults: Partial<DesktopSettings> = {
  theme: DEFAULT_DESKTOP_SETTINGS.theme,
  accent: DEFAULT_DESKTOP_SETTINGS.accent,
  pluginTheme: DEFAULT_DESKTOP_SETTINGS.pluginTheme,
  messageFontSize: DEFAULT_DESKTOP_SETTINGS.messageFontSize,
  codeFontSize: DEFAULT_DESKTOP_SETTINGS.codeFontSize,
  codeWrap: DEFAULT_DESKTOP_SETTINGS.codeWrap,
  reducedMotion: DEFAULT_DESKTOP_SETTINGS.reducedMotion
}

type Palette = {
  canvas: string
  raised: string
  composer: string
  chip: string
  line: string
  muted: string
  accent: string
}

/** Fixed previews: a card shows its own theme regardless of the one in use. */
const BASE_PALETTES: Record<'light' | 'dark', Omit<Palette, 'accent'>> = {
  light: {
    canvas: '#ffffff',
    raised: '#f8f8f7',
    composer: '#ffffff',
    chip: '#f0f0ee',
    line: '#e6e5e1',
    muted: '#6b6a65'
  },
  dark: {
    canvas: '#171717',
    raised: '#1c1c1c',
    composer: '#212121',
    chip: '#2c2c2c',
    line: '#303030',
    muted: '#9f9f9f'
  }
}

const ACCENTS: Record<AccentColor, { label: string; light: string; dark: string }> = {
  blue: { label: t('蓝色'), light: '#3d5fd1', dark: '#5b7be0' },
  violet: { label: t('紫色'), light: '#6b4fd4', dark: '#8a72e8' },
  green: { label: t('绿色'), light: '#1e7a4c', dark: '#3f9a6b' },
  orange: { label: t('橙色'), light: '#c0561b', dark: '#cf773b' },
  pink: { label: t('粉色'), light: '#c0396f', dark: '#cf5f8d' }
}

function palette(base: 'light' | 'dark', accent: AccentColor): Palette {
  return { ...BASE_PALETTES[base], accent: ACCENTS[accent][base] }
}

function pluginPalette(theme: PluginThemeSummary, accent: AccentColor): Palette {
  const fallback = palette(theme.base, accent)
  const token = (name: string, value: string): string => theme.tokens[`--${name}`] ?? value
  return {
    canvas: token('canvas', fallback.canvas),
    raised: token('raised', fallback.raised),
    composer: token('composer', fallback.composer),
    chip: token('chip', fallback.chip),
    line: token('line', fallback.line),
    muted: token('muted', fallback.muted),
    accent: token('accent', fallback.accent)
  }
}

function paletteStyle(colors: Palette): CSSProperties {
  return {
    '--p-canvas': colors.canvas,
    '--p-raised': colors.raised,
    '--p-composer': colors.composer,
    '--p-chip': colors.chip,
    '--p-line': colors.line,
    '--p-muted': colors.muted,
    '--p-accent': colors.accent
  } as CSSProperties
}

function MiniWindow({ colors }: { colors: Palette }): React.JSX.Element {
  return (
    <span className="sp-theme-window" style={paletteStyle(colors)}>
      <span className="sp-mini-sidebar">
        <i />
        <i />
        <i />
      </span>
      <span className="sp-mini-main">
        <span className="sp-mini-bubble" />
        <span className="sp-mini-line" />
        <span className="sp-mini-composer">
          <b />
        </span>
      </span>
    </span>
  )
}

function ThemeCard({
  label,
  hint,
  checked,
  disabled,
  onSelect,
  preview
}: {
  label: string
  hint?: string
  checked: boolean
  disabled: boolean
  onSelect: () => void
  preview: React.JSX.Element
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={label}
      className="sp-theme-card"
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="sp-theme-preview">{preview}</span>
      <span>
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
    </button>
  )
}

export default function AppearanceSettings(): React.JSX.Element {
  const { settings, save, status } = useDesktopSettings()
  const pluginThemes = usePluginThemes((state) => state.themes)
  const disabled = status !== 'ready'
  const activePluginTheme = pluginThemes.find(({ id }) => id === settings.pluginTheme) ?? null
  const choose = (theme: DesktopSettings['theme']): void => void save({ theme, pluginTheme: null })

  return (
    <SettingsPage title={t('外观')} description={t('只影响 Pi Desktop，修改后立即生效。')}>
      <SettingsGroup title={t('主题')}>
        <SettingsRow
          label={t('界面主题')}
          description={t('跟随系统时会随系统的浅色、深色外观实时切换。')}
          stacked
        >
          <div className="sp-theme-grid" role="radiogroup" aria-label={t('主题')}>
            <ThemeCard
              label={t('跟随系统')}
              checked={!activePluginTheme && settings.theme === 'system'}
              disabled={disabled}
              onSelect={() => choose('system')}
              preview={
                <>
                  <MiniWindow colors={palette('light', settings.accent)} />
                  <span className="sp-theme-half">
                    <MiniWindow colors={palette('dark', settings.accent)} />
                  </span>
                </>
              }
            />
            <ThemeCard
              label={t('浅色')}
              checked={!activePluginTheme && settings.theme === 'light'}
              disabled={disabled}
              onSelect={() => choose('light')}
              preview={<MiniWindow colors={palette('light', settings.accent)} />}
            />
            <ThemeCard
              label={t('深色')}
              checked={!activePluginTheme && settings.theme === 'dark'}
              disabled={disabled}
              onSelect={() => choose('dark')}
              preview={<MiniWindow colors={palette('dark', settings.accent)} />}
            />
            {pluginThemes.map((theme) => (
              <ThemeCard
                key={theme.id}
                label={theme.label}
                hint={t('来自 {pluginName}', { pluginName: theme.pluginName })}
                checked={activePluginTheme?.id === theme.id}
                disabled={disabled}
                onSelect={() => void save({ theme: theme.base, pluginTheme: theme.id })}
                preview={<MiniWindow colors={pluginPalette(theme, settings.accent)} />}
              />
            ))}
          </div>
        </SettingsRow>
        <SettingsRow
          label={t('强调色')}
          description={
            activePluginTheme
              ? t('由主题「{label}」决定；切回内置主题后可选。', { label: activePluginTheme.label })
              : t('按钮、选中项和链接使用的颜色。')
          }
        >
          <div className="sp-swatches" role="radiogroup" aria-label={t('强调色')}>
            {(Object.keys(ACCENTS) as AccentColor[]).map((accent) => (
              <button
                key={accent}
                type="button"
                role="radio"
                className="sp-swatch"
                aria-checked={settings.accent === accent}
                aria-label={ACCENTS[accent].label}
                title={ACCENTS[accent].label}
                disabled={disabled || activePluginTheme !== null}
                style={{ '--swatch': ACCENTS[accent].light } as CSSProperties}
                onClick={() => void save({ accent })}
              />
            ))}
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t('文字')}>
        <SettingsRow label={t('消息字号')} description={t('对话正文的大小，不影响侧栏和面板。')}>
          <SelectControl
            label={t('消息字号')}
            value={settings.messageFontSize}
            disabled={disabled}
            onChange={(value) => void save({ messageFontSize: Number(value) })}
          >
            {[13, 14, 15, 16, 17, 18].map((size) => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </SelectControl>
        </SettingsRow>
        <SettingsRow label={t('代码字号')} description={t('对话中代码块和行内代码的大小。')}>
          <SelectControl
            label={t('代码字号')}
            value={settings.codeFontSize}
            disabled={disabled}
            onChange={(value) => void save({ codeFontSize: Number(value) })}
          >
            {[11, 12, 13, 14, 15, 16].map((size) => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </SelectControl>
        </SettingsRow>
        <SettingsRow
          label={t('代码默认换行')}
          description={t('长代码行自动换行；每个代码块仍可单独切换。')}
        >
          <Switch
            label={t('代码默认换行')}
            checked={settings.codeWrap}
            disabled={disabled}
            onChange={(codeWrap) => void save({ codeWrap })}
          />
        </SettingsRow>
        <div className="sp-preview" aria-label={t('阅读预览')}>
          <p style={{ fontSize: settings.messageFontSize }}>
            {t('清晰呈现每一步思考与结果，长段落也读得舒服。')}
          </p>
          <pre
            style={{
              fontSize: settings.codeFontSize,
              whiteSpace: settings.codeWrap ? 'pre-wrap' : 'pre'
            }}
          >
            <HighlightedCode
              text={t("const greeting = await pi.ask('今天，我们完成什么？')")}
              language="typescript"
            />
          </pre>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('动效')}>
        <SettingsRow
          label={t('减少动态效果')}
          description={t('减少界面动画与过渡；系统开启时也会自动遵守。')}
        >
          <Switch
            label={t('减少动态效果')}
            checked={settings.reducedMotion}
            disabled={disabled}
            onChange={(reducedMotion) => void save({ reducedMotion })}
          />
        </SettingsRow>
      </SettingsGroup>
      <PreferencesFooter resetPatch={appearanceDefaults} />
    </SettingsPage>
  )
}
