import { useState } from 'react'
import { ArrowLeft, Check, LoaderCircle, RefreshCw, X } from 'lucide-react'
import {
  createCustomEndpointSchema,
  customEndpointUrlSchema,
  endpointDiscoverSchema,
  type CustomEndpointApi
} from '../../../shared/custom-endpoints'
import { useSettingsDraft } from './SettingsDraftContext'

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
    hint: 'GPT 系列',
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
    hint: '多家模型聚合',
    baseUrl: 'https://openrouter.ai/api/v1',
    api: 'openai-completions'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    hint: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'openai-completions'
  },
  {
    id: 'ollama',
    label: 'Ollama',
    hint: '本机模型',
    baseUrl: 'http://localhost:11434/v1',
    api: 'openai-completions',
    keyOptional: true
  },
  {
    id: 'custom',
    label: '自定义',
    hint: '任意兼容接口',
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
  const [engine, setEngine] = useState<Engine>('pi')
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
    setEngine('pi')
    setModels(null)
    setChosen([])
    setManual('')
    setError('')
    setNote('')
  }
  const claudeAllowed = claudeAvailable && api === 'anthropic-messages'
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
      setError('请填写有效的服务地址（HTTPS，或本机 http://localhost）和 API Key。')
      return
    }
    setBusy('discover')
    setError('')
    setNote('')
    try {
      const response = await window.pi.runtimeConfig('pi', command.data)
      setModels(response.result.modelIds)
      setChosen(response.result.modelIds.slice(0, 20))
      setBaseUrl(response.result.baseUrl)
      setNote(
        response.result.modelIds.length
          ? `找到 ${response.result.modelIds.length} 个模型${response.result.truncated ? '（未完整返回）' : ''}，已勾选前 ${Math.min(20, response.result.modelIds.length)} 个。`
          : '服务没有返回模型列表，请在下面手动填写模型 ID。'
      )
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '拉取失败，可以手动填写模型 ID。')
      setModels([])
    } finally {
      setBusy(null)
    }
  }

  const save = async (): Promise<void> => {
    setError('')
    if (engine === 'claude') {
      const url = baseUrl.trim()
      if (!key.trim()) {
        setError('请填写 API Key。')
        return
      }
      if (url && !customEndpointUrlSchema.safeParse(url).success) {
        setError('服务地址必须是 HTTPS，或本机 http://localhost。')
        return
      }
      setBusy('save')
      try {
        await window.pi.runtimeConfig('claude', {
          type: 'account:api-key:set',
          providerId: 'new',
          apiKey: key.trim(),
          ...(url && url !== 'https://api.anthropic.com' ? { baseUrl: url } : {}),
          ...(label.trim() ? { label: label.trim() } : {})
        })
        onSaved('claude')
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(null)
      }
      return
    }
    const endpoint = createCustomEndpointSchema.safeParse({
      label: label.trim() || preset?.label || '自定义端点',
      api,
      baseUrl: baseUrl.trim(),
      modelIds,
      key: effectiveKey
    })
    if (!endpoint.success) {
      setError(
        modelIds.length
          ? '请检查服务地址和 API Key。'
          : '至少需要一个模型：先拉取模型，或手动填写模型 ID。'
      )
      return
    }
    setBusy('save')
    try {
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
      onSaved('pi')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="ea-panel" role="group" aria-label="添加 API 连接">
      <div className="ea-panel-head">
        {preset ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="返回选择服务"
            onClick={() => setPreset(null)}
          >
            <ArrowLeft size={15} />
          </button>
        ) : null}
        <strong>{preset ? `添加 ${preset.label}` : '选择要接入的服务'}</strong>
        <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
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
            <div className="ea-segment" role="radiogroup" aria-label="用于哪个引擎">
              {(['pi', 'claude'] as const).map((value) => (
                <button
                  type="button"
                  role="radio"
                  key={value}
                  aria-checked={engine === value}
                  onClick={() => setEngine(value)}
                >
                  {value === 'pi' ? '用于 Pi' : '用于 Claude Code'}
                </button>
              ))}
            </div>
          ) : null}
          <label htmlFor="api-label">名称</label>
          <input
            id="api-label"
            value={label}
            placeholder={preset.label === '自定义' ? '例如：公司网关' : preset.label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <label htmlFor="api-url">服务地址</label>
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
              <label htmlFor="api-protocol">接口协议</label>
              <select
                id="api-protocol"
                value={api}
                onChange={(event) => {
                  setApi(event.target.value as CustomEndpointApi)
                  setModels(null)
                  if (event.target.value !== 'anthropic-messages') setEngine('pi')
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
            API Key {preset.keyOptional ? <span>本机服务可留空</span> : null}
          </label>
          <input
            id="api-key"
            type="password"
            value={key}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setKey(event.target.value)}
          />

          {engine === 'pi' ? (
            <div className="ea-models">
              <div className="ea-models-head">
                <span>模型</span>
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
                  测试并拉取模型
                </button>
              </div>
              {models?.length ? (
                <div className="ea-model-list" role="group" aria-label="选择模型">
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
                aria-label="手动填写模型 ID"
                rows={2}
                value={manual}
                placeholder="也可以手动填写模型 ID，每行一个"
                onChange={(event) => setManual(event.target.value)}
              />
            </div>
          ) : (
            <p className="ea-hint">Claude Code 会自动列出这个服务可用的模型。</p>
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
              取消
            </button>
            <button
              type="submit"
              className="acct-button is-primary"
              disabled={busy !== null || (engine === 'pi' ? !modelIds.length : !key.trim())}
            >
              {busy === 'save' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
              保存连接
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
