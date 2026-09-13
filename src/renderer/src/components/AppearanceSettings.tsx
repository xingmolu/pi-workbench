import { useDesktopSettings } from '../store/desktop-settings'
import { PreferenceRow, PreferencesFrame } from './GeneralSettings'

export default function AppearanceSettings(): React.JSX.Element {
  const { settings, save } = useDesktopSettings()
  return (
    <PreferencesFrame title="外观">
      <PreferenceRow label="消息字号" description="调整对话正文，不改变窗口或其他面板字号。">
        <select
          value={settings.messageFontSize}
          onChange={(e) => void save({ messageFontSize: Number(e.target.value) })}
        >
          {[13, 14, 15, 16, 17, 18].map((n) => (
            <option key={n} value={n}>
              {n} px
            </option>
          ))}
        </select>
      </PreferenceRow>
      <PreferenceRow label="代码字号" description="调整对话中的代码阅读大小。">
        <select
          value={settings.codeFontSize}
          onChange={(e) => void save({ codeFontSize: Number(e.target.value) })}
        >
          {[11, 12, 13, 14, 15, 16].map((n) => (
            <option key={n} value={n}>
              {n} px
            </option>
          ))}
        </select>
      </PreferenceRow>
      <PreferenceRow label="代码默认换行" description="长代码默认自动换行；每个代码块可独立切换。">
        <input
          type="checkbox"
          checked={settings.codeWrap}
          onChange={(e) => void save({ codeWrap: e.target.checked })}
        />
      </PreferenceRow>
      <PreferenceRow
        label="减少动态效果"
        description="减少界面动画与过渡；同时尊重系统的减少动态效果设置。"
      >
        <input
          type="checkbox"
          checked={settings.reducedMotion}
          onChange={(e) => void save({ reducedMotion: e.target.checked })}
        />
      </PreferenceRow>
      <div className="desktop-reading-preview" aria-label="阅读预览">
        <p style={{ fontSize: settings.messageFontSize }}>阅读预览 · 清晰呈现每一步思考与结果。</p>
        <pre
          style={{
            fontSize: settings.codeFontSize,
            whiteSpace: settings.codeWrap ? 'pre-wrap' : 'pre'
          }}
        >
          const message = '你好，Pi Desktop';
        </pre>
      </div>
    </PreferencesFrame>
  )
}
