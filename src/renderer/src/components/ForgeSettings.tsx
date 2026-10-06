import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { ForgeAccount, ForgeAccountsCommand } from '../../../shared/forge'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsPrimitives'
import { t } from '../../../shared/i18n'

const SOURCE: Record<NonNullable<ForgeAccount['source']>, string> = {
  saved: t('已保存的令牌'),
  environment: t('环境变量 GH_TOKEN / GITHUB_TOKEN'),
  gh: t('GitHub CLI（gh auth login）')
}

function cleanError(error: unknown): string {
  return (
    (error instanceof Error ? error.message : '').replace(
      /^Error invoking remote method '[^']+': (?:Error: )?/,
      ''
    ) || t('操作失败，请重试')
  )
}

/** Accounts on code hosts that the code review page reads pull requests with. */
export default function ForgeSettings(): React.JSX.Element {
  const [accounts, setAccounts] = useState<ForgeAccount[] | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (command: ForgeAccountsCommand): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setAccounts(await window.pi.forgeAccounts(command))
      if (command.type === 'token:set') setToken('')
    } catch (cause) {
      setError(cleanError(cause))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void run({ type: 'list' })
  }, [])

  const github = accounts?.find(({ host }) => host === 'github.com')
  return (
    <SettingsPage
      title={t('代码托管')}
      description={t(
        '代码审查页面用这些账号读取拉取请求、合并和发表评论。令牌只保存在本机，插件页面拿不到。'
      )}
    >
      <SettingsGroup title="GitHub">
        <SettingsRow
          label={
            github?.viewer
              ? t('已登录为 {viewer}', { viewer: github.viewer })
              : github?.source
                ? t('令牌无法验证')
                : t('未登录')
          }
          description={
            accounts === null
              ? t('正在读取…')
              : github?.source
                ? t('来源：{source}', { source: SOURCE[github.source] })
                : t(
                    '安装 GitHub CLI 并运行 gh auth login，或在下面保存一个令牌（需要 repo 权限）。'
                  )
          }
        >
          {github?.source === 'saved' ? (
            <button
              type="button"
              className="acct-button is-quiet"
              disabled={busy}
              onClick={() => void run({ type: 'token:clear', host: 'github.com' })}
            >
              {t('移除令牌')}
            </button>
          ) : busy && accounts === null ? (
            <LoaderCircle size={14} className="spin" />
          ) : null}
        </SettingsRow>
        {github?.source !== 'saved' ? (
          <SettingsRow
            label={t('GitHub 令牌')}
            description={t('保存的令牌优先于 GitHub CLI 和环境变量。')}
          >
            <form
              className="sp-inline-form"
              onSubmit={(event) => {
                event.preventDefault()
                void run({ type: 'token:set', host: 'github.com', token })
              }}
            >
              <input
                type="password"
                aria-label={t('GitHub 令牌')}
                placeholder="ghp_… / github_pat_…"
                value={token}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setToken(event.target.value)}
              />
              <button type="submit" className="acct-button" disabled={busy || !token.trim()}>
                {busy ? <LoaderCircle size={14} className="spin" /> : null}
                {t('验证并保存')}
              </button>
            </form>
          </SettingsRow>
        ) : null}
      </SettingsGroup>
      <SettingsGroup title="Gitee">
        <SettingsRow label={t('即将支持')} description={t('包括私有部署的 Gitee 企业版。')}>
          {null}
        </SettingsRow>
      </SettingsGroup>
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </SettingsPage>
  )
}
