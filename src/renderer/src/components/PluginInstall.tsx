import { useState } from 'react'
import { FolderOpen, GitBranch, PackageOpen, ShieldAlert, TriangleAlert } from 'lucide-react'
import type { PluginInstallPreview } from '../../../shared/plugin-install'
import { sourceText, type PluginInstall } from '../store/plugin-install'
import {
  PLUGIN_PERMISSIONS,
  isKnownPluginPermission,
  type PluginPermissionRisk
} from '../../../shared/plugin-api'
import { t } from '../../../shared/i18n'

const RISK_LABEL: Record<PluginPermissionRisk, string> = {
  low: t('低'),
  medium: t('中'),
  high: t('高')
}

/** The three ways to bring in a plugin, and the Git address field. */
export function PluginInstallButtons({ install }: { install: PluginInstall }): React.JSX.Element {
  const [gitOpen, setGitOpen] = useState(false)
  const [url, setUrl] = useState('')
  const disabled = install.busy || install.preview !== null
  return (
    <div className="plugin-install" role="group" aria-label={t('安装插件')}>
      <div className="plugin-install-buttons">
        <button type="button" disabled={disabled} onClick={() => void install.pick('folder')}>
          <FolderOpen size={13} aria-hidden="true" />
          {t('从文件夹安装')}
        </button>
        <button type="button" disabled={disabled} onClick={() => void install.pick('zip')}>
          <PackageOpen size={13} aria-hidden="true" />
          {t('从 .zip 安装')}
        </button>
        <button
          type="button"
          aria-expanded={gitOpen}
          disabled={disabled}
          onClick={() => setGitOpen((open) => !open)}
        >
          <GitBranch size={13} aria-hidden="true" />
          {t('从 Git 地址安装')}
        </button>
      </div>
      {gitOpen ? (
        <form
          className="plugin-install-git"
          onSubmit={(event) => {
            event.preventDefault()
            if (url.trim()) void install.inspect({ kind: 'git', url: url.trim() })
          }}
        >
          <input
            type="url"
            aria-label={t('插件的 Git 地址')}
            placeholder="https://github.com/…/….git"
            value={url}
            disabled={disabled}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button type="submit" className="secondary-button" disabled={disabled || !url.trim()}>
            {install.busy ? t('正在下载') : t('下载并检查')}
          </button>
        </form>
      ) : null}
      {install.error ? (
        <div className="plugin-operation-error" role="alert">
          <TriangleAlert size={13} aria-hidden="true" />
          <span>{install.error}</span>
        </div>
      ) : null}
      {install.preview ? <InstallReview install={install} preview={install.preview} /> : null}
    </div>
  )
}

/** What the plugin is and what it asks for, before anything is installed. */
function InstallReview({
  install,
  preview
}: {
  install: PluginInstall
  preview: PluginInstallPreview
}): React.JSX.Element {
  const updating = preview.existingVersion !== null
  return (
    <section
      className="plugin-install-review"
      aria-label={t('检查插件 {name}', { name: preview.name })}
    >
      <header>
        <strong>{preview.name}</strong>
        <span className="plugin-version">{preview.version}</span>
        {preview.verified ? null : (
          <span className="plugin-badge is-unverified">{t('未验证')}</span>
        )}
      </header>
      <p className="plugin-meta">
        <code>{preview.pluginId}</code>
        <span title={sourceText(preview.source)}>{sourceText(preview.source)}</span>
      </p>
      {preview.description ? <p className="plugin-description">{preview.description}</p> : null}
      {updating ? (
        <p>{t('将替换已安装的 {version}。', { version: preview.existingVersion })}</p>
      ) : null}
      <div className="plugin-executable-warning" role="note">
        <ShieldAlert size={13} aria-hidden="true" />
        <span>
          {preview.runsCode
            ? t(
                '未验证的插件。它会用你的账户权限运行代码：下面的权限只约束它调用 Pi Desktop 的接口，不能阻止它直接读写文件或访问网络。只安装来自可信来源的插件。'
              )
            : t('未验证的插件。它只提供界面和声明的内容，不运行代码。只安装来自可信来源的插件。')}
        </span>
      </div>
      <ul className="plugin-grant">
        {preview.permissions.map((permission) => {
          const risk = isKnownPluginPermission(permission) ? PLUGIN_PERMISSIONS[permission] : null
          return (
            <li key={permission} className={risk ? `is-${risk}` : 'is-unsupported'}>
              <code>{permission}</code>
              <span>
                {risk
                  ? t('风险：{value}', { value: RISK_LABEL[risk] })
                  : t('此版本不支持，不会授予')}
              </span>
            </li>
          )
        })}
        {preview.permissions.length === 0 ? <li>{t('不请求额外权限')}</li> : null}
      </ul>
      <div className="plugin-grant-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={install.busy}
          onClick={() => void install.cancel()}
        >
          {t('取消')}
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={install.busy}
          onClick={() => void install.confirm()}
        >
          {updating ? t('更新并启用') : t('安装并启用')}
        </button>
      </div>
    </section>
  )
}
