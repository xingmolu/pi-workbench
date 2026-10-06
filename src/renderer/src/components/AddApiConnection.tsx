import { useState } from 'react'
import {
  ArrowLeft,
  Check,
  CircleCheck,
  CircleMinus,
  LoaderCircle,
  RefreshCw,
  X
} from 'lucide-react'
import {
  createCustomEndpointSchema,
  customEndpointUrlSchema,
  type CustomEndpointApi
} from '../../../shared/custom-endpoints'
import { gatewayProbeInputSchema, type GatewayProbe } from '../../../shared/gateway'
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

type Engine = 'pi' | 'claude' | 'codex'

/** A custom service without a name is called by its host, as in the endpoint list. */
function hostname(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.slice(0, 80)
  } catch {
    return ''
  }
}

/** Without a probe, the chosen protocol says what the address speaks. */
function declared(
  api: CustomEndpointApi,
  baseUrl: string
): Omit<GatewayProbe, 'modelIds' | 'truncated'> {
  return {
    openai:
      api === 'anthropic-messages'
        ? null
        : { baseUrl, chat: api === 'openai-completions', responses: api === 'openai-responses' },
    anthropic: api === 'anthropic-messages' ? { baseUrl, auth: 'x-api-key' } : null
  }
}

/** The protocol Pi uses on a probed service: Chat Completions is the most widely served. */
function piProtocol(probe: GatewayProbe, fallback: CustomEndpointApi): CustomEndpointApi {
  if (probe.openai?.chat) return 'openai-completions'
  if (probe.openai?.responses) return 'openai-responses'
  if (probe.anthropic && !probe.openai) return 'anthropic-messages'
  return fallback === 'anthropic-messages' && !probe.anthropic ? 'openai-completions' : fallback
}

/**
 * One way to connect a service for every engine: pick it, give the address and key once, and
 * the desktop checks which protocols it speaks. Pi uses any of them, Claude Code the Anthropic
 * Messages API and Codex the OpenAI Responses API; each engine keeps its own copy of the key.
 */
export default function AddApiConnection({
  claudeAvailable,
  codexAvailable = false,
  onClose,
  onSaved
}: {
  claudeAvailable: boolean
  codexAvailable?: boolean
  onClose: () => void
  onSaved: (engine: Engine) => void
}): React.JSX.Element {
  const [preset, setPreset] = useState<Preset | null>(null)
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [api, setApi] = useState<CustomEndpointApi>('openai-completions')
  const [key, setKey] = useState('')
  const [probe, setProbe] = useState<GatewayProbe | null>(null)
  const [forPi, setForPi] = useState(true)
  // An engine the service can serve is on unless the user turned it off; engines load
  // asynchronously, so the default follows them rather than being fixed when chosen.
  const [forClaude, setForClaude] = useState<boolean | null>(null)
  const [forCodex, setForCodex] = useState<boolean | null>(null)
  const [bearer, setBearer] = useState(false)
  const [models, setModels] = useState<string[] | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState<'discover' | 'save' | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  useSettingsDraft('add-api', Boolean(preset && (key || baseUrl !== preset.baseUrl)))

  const detected = probe ?? declared(api, baseUrl.trim())
  const claudeAllowed = claudeAvailable && Boolean(detected.anthropic)
  const codexAllowed = codexAvailable && Boolean(detected.openai?.responses)
  const toClaude = claudeAllowed && (forClaude ?? true)
  const toCodex = codexAllowed && (forCodex ?? true)
  const toPi = forPi || (!toClaude && !toCodex)
  const engineChoices =
    1 + Number(claudeAvailable && Boolean(detected.anthropic)) + Number(codexAllowed)

  /** Changing what the service is forgets what was learned about it. */
  const reset = (): void => {
    setProbe(null)
    setModels(null)
    setNote('')
  }
  const choose = (): void => {
    setForPi(true)
    setForClaude(null)
    setForCodex(null)
  }
  const pick = (next: Preset): void => {
    setPreset(next)
    setLabel(next.id === 'custom' ? '' : next.label)
    setBaseUrl(next.baseUrl)
    setApi(next.api)
    setBearer(false)
    choose()
    setProbe(null)
    setModels(null)
    setChosen([])
    setManual('')
    setError('')
    setNote('')
  }
  const effectiveKey = key.trim() || (preset?.keyOptional ? 'ollama' : '')
  const modelIds = [
    ...chosen,
    ...manual
      .split(/[\n,]/)
      .map((id) => id.trim())
      .filter((id) => id && !chosen.includes(id))
  ]

  const discover = async (): Promise<void> => {
    const input = gatewayProbeInputSchema.safeParse({ baseUrl: baseUrl.trim(), key: effectiveKey })
    if (!input.success) {
      setError(t('请填写有效的服务地址（HTTPS，或本机 http://localhost）和 API Key。'))
      return
    }
    setBusy('discover')
    setError('')
    setNote('')
    try {
      const found = await window.pi.gatewayProbe(input.data)
      setProbe(found)
      setApi(piProtocol(found, api))
      setBaseUrl(found.openai?.baseUrl ?? found.anthropic?.baseUrl ?? input.data.baseUrl)
      setBearer(found.anthropic?.auth === 'bearer')
      choose()
      setModels(found.modelIds)
      setChosen(found.modelIds)
      setNote(
        found.modelIds.length
          ? t('找到 {count} 个模型{partial}，已全部选中，可取消不需要的。', {
              count: found.modelIds.length,
              partial: found.truncated ? t('（未完整返回）') : ''
            })
          : t('服务没有返回模型列表，请在下面手动填写模型 ID。')
      )
    } catch (reason) {
      setError(
        (reason instanceof Error ? reason.message : t('拉取失败，可以手动填写模型 ID。')).replace(
          /^Error invoking remote method '[^']+': (?:Error: )?/,
          ''
        )
      )
      setProbe(null)
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
    const piBase =
      api === 'anthropic-messages'
        ? (detected.anthropic?.baseUrl ?? url)
        : (detected.openai?.baseUrl ?? url)
    const endpoint = toPi
      ? createCustomEndpointSchema.safeParse({
          label: name,
          api,
          baseUrl: piBase,
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
    if ((toClaude || toCodex) && !key.trim()) {
      setError(t('请填写 API Key。'))
      return
    }
    if (toCodex && !modelIds.length) {
      setError(t('至少需要一个模型：先拉取模型，或手动填写模型 ID。'))
      return
    }
    const claudeBase = detected.anthropic?.baseUrl ?? url
    const codexBase = detected.openai?.baseUrl ?? url
    for (const address of [toClaude ? claudeBase : '', toCodex ? codexBase : ''])
      if (address && !customEndpointUrlSchema.safeParse(address).success) {
        setError(t('服务地址必须是 HTTPS，或本机 http://localhost。'))
        return
      }
    setBusy('save')
    const done: string[] = []
    const failed: string[] = []
    const attempt = async (engine: string, step: () => Promise<boolean>): Promise<void> => {
      try {
        if (await step()) done.push(engine)
      } catch (reason) {
        failed.push(
          t('{engine}：{message}', {
            engine,
            message: reason instanceof Error ? reason.message : String(reason)
          })
        )
      }
    }
    try {
      if (endpoint?.success)
        await attempt('Pi', async () => {
          const list = await window.pi.runtimeConfig('pi', { type: 'endpoint:list' })
          const response = await window.pi.runtimeConfig('pi', {
            type: 'endpoint:save',
            context: { projectPath: null, sessionId: null, generation: 0 },
            request: { expectedRevision: list.snapshot.revision, endpoint: endpoint.data }
          })
          if (!response.result.ok) throw new Error(response.result.message)
          return true
        })
      if (toClaude)
        await attempt('Claude Code', async () => {
          await window.pi.runtimeConfig('claude', {
            type: 'account:api-key:set',
            providerId: 'new',
            apiKey: key.trim(),
            ...(claudeBase && claudeBase !== 'https://api.anthropic.com'
              ? { baseUrl: claudeBase }
              : {}),
            ...(bearer ? { bearer: true } : {}),
            label: name
          })
          return true
        })
      if (toCodex)
        await attempt('Codex', async () => {
          await window.pi.runtimeConfig('codex', {
            type: 'account:api-key:set',
            providerId: 'new',
            apiKey: key.trim(),
            baseUrl: codexBase,
            modelIds,
            label: name
          })
          return true
        })
      if (failed.length) {
        setError(
          done.length
            ? t('已添加到 {done}，但 {failed}', {
                done: done.join(t('和')),
                failed: failed.join('；')
              })
            : failed.join('；')
        )
        if (done.length) onSaved(done[0] === 'Pi' ? 'pi' : done[0] === 'Codex' ? 'codex' : 'claude')
        return
      }
      onSaved(toPi ? 'pi' : toClaude ? 'claude' : 'codex')
    } finally {
      setBusy(null)
    }
  }

  const protocolRow = (name: string, ok: boolean, detail?: string): React.JSX.Element => (
    <li className={ok ? 'is-ok' : undefined}>
      {ok ? (
        <CircleCheck size={14} aria-hidden="true" />
      ) : (
        <CircleMinus size={14} aria-hidden="true" />
      )}
      <span>{name}</span>
      {detail ? <small>{detail}</small> : null}
    </li>
  )

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
              reset()
            }}
          />
          {preset.id === 'custom' ? (
            <>
              <label htmlFor="api-protocol">{t('接口协议')}</label>
              <select
                id="api-protocol"
                value={api}
                onChange={(event) => {
                  const next = event.target.value as CustomEndpointApi
                  setApi(next)
                  if (!probe) {
                    setModels(null)
                    choose()
                  }
                }}
              >
                {Object.entries(PROTOCOLS).map(([value, name]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
              </select>
              <small className="ea-field-hint">
                {probe
                  ? t('Pi 用这个协议连接；其它引擎按检测结果各用各的。')
                  : t('不确定就先「测试并拉取模型」，会自动识别服务支持的协议。')}
              </small>
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
            onChange={(event) => {
              setKey(event.target.value)
              if (probe) reset()
            }}
          />

          {probe ? (
            <div className="ea-detected" role="group" aria-label={t('检测结果')}>
              <span>{t('这个服务支持')}</span>
              <ul>
                {protocolRow('OpenAI Chat Completions', Boolean(probe.openai?.chat))}
                {protocolRow('OpenAI Responses', Boolean(probe.openai?.responses))}
                {protocolRow(
                  'Anthropic Messages',
                  Boolean(probe.anthropic),
                  probe.anthropic?.auth === 'bearer' ? t('Bearer 认证') : undefined
                )}
              </ul>
            </div>
          ) : null}

          {engineChoices > 1 ? (
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
              {claudeAvailable && detected.anthropic ? (
                <label className="ea-check">
                  <input
                    type="checkbox"
                    checked={toClaude}
                    onChange={(event) => setForClaude(event.target.checked)}
                  />
                  <span>Claude Code</span>
                </label>
              ) : null}
              {codexAllowed ? (
                <label className="ea-check">
                  <input
                    type="checkbox"
                    checked={toCodex}
                    onChange={(event) => setForCodex(event.target.checked)}
                  />
                  <span>Codex</span>
                </label>
              ) : null}
            </div>
          ) : null}
          {probe && claudeAvailable && !probe.anthropic ? (
            <p className="ea-hint">
              {t(
                'Claude Code 只支持 Anthropic Messages 协议，这个服务没有提供，所以不能用于 Claude Code。'
              )}
            </p>
          ) : null}
          {probe && codexAvailable && !probe.openai?.responses ? (
            <p className="ea-hint">
              {t('Codex 只支持 OpenAI Responses 协议，这个服务没有提供，所以不能用于 Codex。')}
            </p>
          ) : null}
          {!probe && claudeAvailable && api !== 'anthropic-messages' && preset.id === 'custom' ? (
            <p className="ea-hint">{t('Claude Code 只支持 Anthropic Messages 协议。')}</p>
          ) : null}
          {toClaude ? (
            <label className="ea-check ea-bearer">
              <input
                type="checkbox"
                checked={bearer}
                onChange={(event) => setBearer(event.target.checked)}
              />
              <span>
                {t('Claude Code 以 Bearer 方式发送密钥（网关只认 Authorization 头时勾选）')}
              </span>
            </label>
          ) : null}

          {toPi || toCodex ? (
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
              disabled={busy !== null || (toPi || toCodex ? !modelIds.length : !key.trim())}
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
