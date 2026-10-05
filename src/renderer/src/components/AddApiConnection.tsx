import { useState } from 'react'
import { ArrowLeft, Check, LoaderCircle, RefreshCw, X } from 'lucide-react'
import {
  createCustomEndpointSchema,
  customEndpointUrlSchema,
  endpointDiscoverSchema,
  type CustomEndpointApi
} from '../../../shared/custom-endpoints'
import { useSettingsDraft } from './SettingsDraftContext'
import { t } from '../../../shared/i18n'

type Preset = {
  id: string
  label: string
  hint: string
  baseUrl: string
  api: CustomEndpointApi
  /** Local servers usually ignore the key; a placeholder keeps Pi's auth slot valid. */
  keyOptional?: boolean
}

export const API_PRESETS: Preset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    hint: t('GPT 系列'),
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-responses'
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    hint: 'Claude API',
    baseUrl: 'https://api.anthropic.com',
    api: 'anthropic-messages'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: t('多家模型聚合'),
    baseUrl: 'https://openrouter.ai/api/v1',
    api: 'openai-completions'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    hint: t('DeepSeek 官方'),
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'openai-completions'
  },
  {
    id: 'ollama',
    label: 'Ollama',
    hint: t('本机模型'),
    baseUrl: 'http://localhost:11434/v1',
    api: 'openai-completions',
    keyOptional: true
  },
  {
    id: 'custom',
    label: t('自定义'),
    hint: t('任意兼容接口'),
    baseUrl: '',
    api: 'openai-completions'
  }
]

const PROTOCOLS: Record<CustomEndpointApi, string> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages'
}

type Engine = 'pi' | 'claude'

/** A custom service without a name is called by its host, as in the endpoint list. */
function hostname(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.slice(0, 80)
  } catch {
    return ''
  }
}

/**
 * One way to add an API connection for any engine: pick a service, give the key, and
 * (for Pi) fetch and choose models. Claude Code takes Anthropic-compatible services only.
 */
export default function AddApiConnection({
  claudeAvailable,
  onClose,
  onSaved
}: {
  claudeAvailable: boolean
  onClose: () => void
  onSaved: (engine: Engine) => void
}): React.JSX.Element {
  const [preset, setPreset] = useState<Preset | null>(null)
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [api, setApi] = useState<CustomEndpointApi>('openai-completions')
  const [key, setKey] = useState('')
  // Which engines get the service; an Anthropic-compatible one serves both by default.
  const [forPi, setForPi] = useState(true)
  const [forClaude, setForClaude] = useState(false)
  const [models, setModels] = useState<string[] | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState<'discover' | 'save' | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  useSettingsDraft('add-api', Boolean(preset && (key || baseUrl !== preset.baseUrl)))

  const pick = (next: Preset): void => {
    setPreset(next)
    setLabel(next.id === 'custom' ? '' : next.label)
    setBaseUrl(next.baseUrl)
    setApi(next.api)
    setForPi(true)
    setForClaude(claudeAvailable && next.api === 'anthropic-messages')
    setModels(null)
    setChosen([])
    setManual('')
    setError('')
    setNote('')
  }
  const claudeAllowed = claudeAvailable && api === 'anthropic-messages'
  const toClaude = claudeAllowed && forClaude
  const toPi = forPi || !claudeAllowed
  const effectiveKey = key.trim() || (preset?.keyOptional ? 'ollama' : '')
  const modelIds = [
    ...chosen,
    ...manual
      .split(/[\n,]/)
      .map((id) => id.trim())
      .filter((id) => id && !chosen.includes(id))
  ]

  const discover = async (): Promise<void> => {
    const command = endpointDiscoverSchema.safeParse({
      type: 'endpoint:discover',
      baseUrl: baseUrl.trim(),
      key: effectiveKey,
      api
    })
    if (!command.success) {
      setError(t('请填写有效的服务地址（HTTPS，或本机 http://localhost）和 API Key。'))
      return
    }
    setBusy('discover')
    setError('')
    setNote('')
    try {
      const response = await window.pi.runtimeConfig('pi', command.data)
      setModels(response.result.modelIds)
      setChosen(response.result.modelIds)
      setBaseUrl(response.result.baseUrl)
      setNote(
        response.result.modelIds.length
          ? t('找到 {count} 个模型{partial}，已全部选中，可取消不需要的。', {
              count: response.result.modelIds.length,
              partial: response.result.truncated ? t('（未完整返回）') : ''
            })
          : t('服务没有返回模型列表，请在下面手动填写模型 ID。')
      )
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('拉取失败，可以手动填写模型 ID。'))
      setModels([])
    } finally {
      setBusy(null)
    }
  }

  const save = async (): Promise<void> => {
    setError('')
    const url = baseUrl.trim()
    const name =
      label.trim() || (preset?.id === 'custom' ? hostname(url) : preset?.label) || t('自定义端点')
    const endpoint = toPi
      ? createCustomEndpointSchema.safeParse({
          label: name,
          api,
          baseUrl: url,
          modelIds,
          key: effectiveKey
        })
      : null
    if (endpoint && !endpoint.success) {
      setError(
        modelIds.length
          ? t('请检查服务地址和 API Key。')
          : t('至少需要一个模型：先拉取模型，或手动填写模型 ID。')
      )
      return
    }
    if (toClaude) {
      if (!key.trim()) {
        setError(t('请填写 API Key。'))
        return
      }
      if (url && !customEndpointUrlSchema.safeParse(url).success) {
        setError(t('服务地址必须是 HTTPS，或本机 http://localhost。'))
        return
      }
    }
    setBusy('save')
    let piSaved = false
    try {
      if (endpoint?.success) {
        const list = await window.pi.runtimeConfig('pi', { type: 'endpoint:list' })
        const response = await window.pi.runtimeConfig('pi', {
          type: 'endpoint:save',
          context: { projectPath: null, sessionId: null, generation: 0 },
          request: { expectedRevision: list.snapshot.revision, endpoint: endpoint.data }
        })
        if (!response.result.ok) {
          setError(response.result.message)
          return
        }
        piSaved = true
      }
      if (toClaude)
        await window.pi.runtimeConfig('claude', {
          type: 'account:api-key:set',
          providerId: 'new',
          apiKey: key.trim(),
          ...(url && url !== 'https://api.anthropic.com' ? { baseUrl: url } : {}),
          label: name
        })
      onSaved(toPi ? 'pi' : 'claude')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(
        piSaved ? t('已添加到 Pi，但添加到 Claude Code 失败：{message}', { message }) : message
      )
      if (piSaved) onSaved('pi')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="ea-panel" role="group" aria-label={t('添加端点')}>
      <div className="ea-panel-head">
        {preset ? (
          <button
            type="button"
            className="icon-btn"
            aria-label={t('返回选择服务')}
            onClick={() => setPreset(null)}
          >
            <ArrowLeft size={15} />
          </button>
        ) : null}
        <strong>
          {preset ? t('添加 {label}', { label: preset.label }) : t('选择要接入的服务')}
        </strong>
        <button type="button" className="icon-btn" aria-label={t('关闭')} onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      {!preset ? (
        <div className="ea-presets">
          {API_PRESETS.map((item) => (
            <button type="button" key={item.id} className="ea-preset" onClick={() => pick(item)}>
              <strong>{item.label}</strong>
              <small>{item.hint}</small>
            </button>
          ))}
        </div>
      ) : (
        <form
          className="ea-form is-flat"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          {claudeAllowed ? (
            <div className="ea-engines" role="group" aria-label={t('用于哪些引擎')}>
              <span>{t('用于')}</span>
              <label className="ea-check">
                <input
                  type="checkbox"
                  checked={forPi}
                  onChange={(event) => setForPi(event.target.checked)}
                />
                <span>Pi</span>
              </label>
              <label className="ea-check">
                <input
                  type="checkbox"
                  checked={forClaude}
                  onChange={(event) => setForClaude(event.target.checked)}
                />
                <span>Claude Code</span>
              </label>
            </div>
          ) : null}
          <label htmlFor="api-label">{t('名称')}</label>
          <input
            id="api-label"
            value={label}
            placeholder={preset.label === t('自定义') ? t('例如：公司网关') : preset.label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <label htmlFor="api-url">{t('服务地址')}</label>
          <input
            id="api-url"
            value={baseUrl}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            onChange={(event) => {
              setBaseUrl(event.target.value)
              setModels(null)
            }}
          />
          {preset.id === 'custom' ? (
            <>
              <label htmlFor="api-protocol">{t('接口协议')}</label>
              <select
                id="api-protocol"
                value={api}
                onChange={(event) => {
                  setApi(event.target.value as CustomEndpointApi)
                  setModels(null)
                  setForClaude(claudeAvailable && event.target.value === 'anthropic-messages')
                }}
              >
                {Object.entries(PROTOCOLS).map(([value, name]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <label htmlFor="api-key">
            API Key {preset.keyOptional ? <span>{t('本机服务可留空')}</span> : null}
          </label>
          <input
            id="api-key"
            type="password"
            value={key}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setKey(event.target.value)}
          />

          {toPi ? (
            <div className="ea-models">
              <div className="ea-models-head">
                <span>{t('模型')}</span>
                <button
                  type="button"
                  className="acct-button is-quiet"
                  disabled={busy !== null || !baseUrl.trim() || !effectiveKey}
                  onClick={() => void discover()}
                >
                  {busy === 'discover' ? (
                    <LoaderCircle size={13} className="spin" />
                  ) : (
                    <RefreshCw size={13} />
                  )}

                  {t('测试并拉取模型')}
                </button>
              </div>
              {models?.length ? (
                <div className="ea-models-head">
                  <span>
                    {t('已选 {count} / {total}', { count: chosen.length, total: models.length })}
                  </span>
                  <button
                    type="button"
                    className="acct-button is-quiet"
                    onClick={() => setChosen(chosen.length === models.length ? [] : models)}
                  >
                    {chosen.length === models.length ? t('全部取消') : t('全选')}
                  </button>
                </div>
              ) : null}
              {models?.length ? (
                <div className="ea-model-list" role="group" aria-label={t('选择模型')}>
                  {models.map((id) => (
                    <label key={id} className="ea-check">
                      <input
                        type="checkbox"
                        checked={chosen.includes(id)}
                        onChange={(event) =>
                          setChosen((list) =>
                            event.target.checked
                              ? [...list, id]
                              : list.filter((item) => item !== id)
                          )
                        }
                      />
                      <span>{id}</span>
                    </label>
                  ))}
                </div>
              ) : null}
              <textarea
                aria-label={t('手动填写模型 ID')}
                rows={2}
                value={manual}
                placeholder={t('也可以手动填写模型 ID，每行一个')}
                onChange={(event) => setManual(event.target.value)}
              />
            </div>
          ) : (
            <p className="ea-hint">{t('Claude Code 会自动列出这个服务可用的模型。')}</p>
          )}

          {note ? (
            <p className="ea-hint" role="status">
              {note}
            </p>
          ) : null}
          {error ? (
            <p className="inline-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="ea-form-actions">
            <button
              type="button"
              className="acct-button"
              onClick={onClose}
              disabled={busy !== null}
            >
              {t('取消')}
            </button>
            <button
              type="submit"
              className="acct-button is-primary"
              disabled={
                busy !== null || (!toPi && !toClaude) || (toPi ? !modelIds.length : !key.trim())
              }
            >
              {busy === 'save' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}

              {t('保存端点')}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
