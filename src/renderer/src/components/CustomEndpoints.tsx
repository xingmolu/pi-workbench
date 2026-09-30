import { useEffect, useRef, useState } from 'react'
import { Plus, RefreshCw, Server } from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import {
  endpointDiscoverSchema,
  createCustomEndpointSchema,
  customEndpointSchema,
  type CustomEndpointApi,
  type CustomEndpointConfigSnapshot,
  type CustomEndpointMetadata,
  type CustomEndpointSaveResult
} from '../../../shared/custom-endpoints'
import { endpointContext } from '../store/pi-store'
import { confirmDiscardSettingsDraft, useSettingsDraft } from './SettingsDraftContext'

const protocols: Record<CustomEndpointApi, string> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages'
}
function endpointLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.slice(0, 80)
  } catch {
    return ''
  }
}

type Form = {
  id?: string
  label: string
  api: CustomEndpointApi
  baseUrl: string
  modelIds: string
  imageModelIds: string[]
  originalIds: string[]
}
const emptyForm = (): Form => ({
  label: '',
  api: 'openai-completions',
  baseUrl: '',
  modelIds: '',
  imageModelIds: [],
  originalIds: []
})

export default function CustomEndpoints({
  snapshot
}: {
  snapshot: AgentSnapshot
}): React.JSX.Element {
  const [catalog, setCatalog] = useState<CustomEndpointConfigSnapshot | null>(null)
  const [path, setPath] = useState('')
  const [form, setForm] = useState<Form | null>(null)
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [errorField, setErrorField] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<CustomEndpointSaveResult | null>(null)
  const [pending, setPending] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [discoveryNote, setDiscoveryNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [confirmedRemoval, setConfirmedRemoval] = useState(false)
  const epoch = useRef(0)
  const mounted = useRef(false)
  const submitting = useRef(false)
  const baseline = useRef<Form | null>(null)
  const context = endpointContext(snapshot)
  const identity = JSON.stringify(context)
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const loginActive = !['idle', 'success', 'error'].includes(snapshot.login.phase)
  const disabled =
    !snapshot.ready || snapshot.busy || loginActive || pending || loading || discovering

  const refresh = async (): Promise<void> => {
    const operation = ++epoch.current
    baseline.current = null
    setForm(null)
    setKey('')
    setError('')
    setErrorField(null)
    setOutcome(null)
    setDiscovering(false)
    setLoading(true)
    try {
      const response = await window.pi.send({ type: 'endpoint:list' })
      if (!mounted.current || operation !== epoch.current) return
      setCatalog(response.snapshot)
      setPath(response.configPath)
    } catch {
      if (mounted.current && operation === epoch.current) {
        setCatalog(null)
        setError(
          '无法读取端点配置。请检查 Pi models.json 的格式或权限后刷新列表；此处不会覆盖无效配置。'
        )
      }
    } finally {
      if (mounted.current && operation === epoch.current) setLoading(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      epoch.current += 1
    }
  }, [identity])

  const edit = (endpoint?: CustomEndpointMetadata): void => {
    epoch.current += 1
    setDiscovering(false)
    setKey('')
    setError('')
    setErrorField(null)
    setOutcome(null)
    setConfirmedRemoval(false)
    setDiscoveryNote('')
    const next = endpoint
      ? {
          id: endpoint.id,
          label: endpoint.label,
          api: endpoint.api!,
          baseUrl: endpoint.baseUrl!,
          modelIds: endpoint.modelIds.join('\n'),
          imageModelIds: endpoint.imageModelIds ?? [],
          originalIds: endpoint.modelIds
        }
      : emptyForm()
    baseline.current = next
    setForm(next)
  }
  const cancel = (): void => {
    epoch.current += 1
    setDiscovering(false)
    baseline.current = null
    setForm(null)
    setKey('')
    setError('')
    setConfirmedRemoval(false)
  }
  const update = (value: Partial<Form>): void => {
    setDiscoveryNote('')
    setForm((current) => {
      if (!current) return null
      const next = { ...current, ...value }
      if (value.modelIds !== undefined) {
        const nextIds = new Set(value.modelIds.split('\n').map((id) => id.trim()))
        next.imageModelIds = next.imageModelIds.filter((id) => nextIds.has(id))
      }
      return next
    })
    setConfirmedRemoval(false)
    setError('')
    setErrorField(null)
  }
  const ids =
    form?.modelIds
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean) ?? []
  const removed = form?.originalIds.filter((id) => !ids.includes(id)) ?? []
  const dirty = Boolean(
    form && (key !== '' || JSON.stringify(form) !== JSON.stringify(baseline.current))
  )
  useSettingsDraft('custom-endpoints', dirty)

  const discover = async (): Promise<void> => {
    if (!form || disabled) return
    const parsed = endpointDiscoverSchema.safeParse({
      type: 'endpoint:discover',
      baseUrl: form.baseUrl.trim(),
      key,
      api: form.api
    })
    if (!parsed.success) {
      setError('请填写有效的服务 URL 和 API Key；编辑已有端点时，拉取模型也需要重新输入密钥。')
      return
    }
    const operation = ++epoch.current
    setDiscovering(true)
    setError('')
    setDiscoveryNote('')
    try {
      const response = await window.pi.send(parsed.data)
      if (!mounted.current || operation !== epoch.current) return
      update({ modelIds: response.result.modelIds.join('\n'), baseUrl: response.result.baseUrl })
      setDiscoveryNote(
        `已获取 ${response.result.modelIds.length} 个模型${response.result.truncated ? '（列表未完整返回，可在高级设置中补充）' : ''}，保存后即可选择。`
      )
    } catch (error) {
      if (mounted.current && operation === epoch.current)
        setError(error instanceof Error ? error.message : '拉取失败，请重试或手动填写模型。')
    } finally {
      if (mounted.current && operation === epoch.current) setDiscovering(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!form || !catalog || disabled || submitting.current) return
    const input = {
      label: form.label.trim() || endpointLabel(form.baseUrl),
      api: form.api,
      baseUrl: form.baseUrl.trim(),
      modelIds: ids,
      imageModelIds: form.imageModelIds,
      ...(key !== '' ? { key } : {})
    }
    const parsed = (form.id ? customEndpointSchema : createCustomEndpointSchema).safeParse(input)
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0]
      setErrorField(String(field))
      setError(
        field === 'baseUrl'
          ? 'Base URL 必须为 HTTPS，或 http://localhost、127.0.0.1、[::1]；不能含账号、查询参数或片段。'
          : field === 'modelIds'
            ? '模型 ID 每行一个，不能重复；请填写 1–100 个，每个不超过 200 个字符。'
            : field === 'imageModelIds'
              ? '支持图片输入的模型必须出现在模型 ID 列表中。'
              : field === 'key'
                ? '新端点必须填写 API Key；本地服务也需明确填写占位值。'
                : '显示名称需为 1–80 个字符，不能包含控制字符。'
      )
      return
    }
    if (removed.length && !confirmedRemoval) {
      setError('请确认下面将移除的模型，再保存端点。')
      return
    }
    const operation = ++epoch.current
    const capturedIdentity = identity
    submitting.current = true
    setPending(true)
    setError('')
    setOutcome(null)
    setKey('')
    try {
      const response = await window.pi.send({
        type: 'endpoint:save',
        context,
        request: {
          ...(form.id ? { id: form.id } : {}),
          expectedRevision: catalog.revision,
          endpoint: parsed.data
        }
      })
      if (
        !mounted.current ||
        operation !== epoch.current ||
        capturedIdentity !== currentIdentity.current
      )
        return
      setOutcome(response.result)
      if (response.result.snapshot) setCatalog(response.result.snapshot)
      // Partial writes are durable too. Reopen the saved identity before another edit.
      if (response.result.metadata === 'saved') {
        baseline.current = null
        setForm(null)
      }
    } catch {
      if (
        mounted.current &&
        operation === epoch.current &&
        capturedIdentity === currentIdentity.current
      ) {
        baseline.current = null
        setForm(null)
        setError('保存结果未知，端点可能已写入。请刷新列表核对后再编辑；密钥已清空，不会自动重试。')
      }
    } finally {
      submitting.current = false
      if (mounted.current) setPending(false)
    }
  }

  return (
    <section className="sp-group acct-endpoints" aria-label="自定义端点">
      <div className="sp-group-header acct-group-header">
        <div>
          <h3>自定义端点</h3>
          <p>
            接入 OpenAI / Anthropic 兼容 API。全局生效，影响所有工作区及 Pi
            CLI；新端点不会自动成为当前模型。
          </p>
        </div>
        <button
          type="button"
          className="acct-button"
          disabled={pending || loading || !snapshot.ready}
          onClick={() => {
            if (!confirmDiscardSettingsDraft(dirty)) return
            baseline.current = null
            void refresh()
          }}
        >
          <RefreshCw size={13} className={loading ? 'spin' : undefined} />
          刷新列表
        </button>
      </div>
      {snapshot.busy || loginActive ? (
        <p className="acct-notice is-warning" role="note">
          {loginActive
            ? '登录正在进行，完成后才能保存端点。'
            : '会话正在运行，结束后才能保存端点。'}
        </p>
      ) : null}
      {error ? (
        <p id="endpoint-error" className="acct-notice is-error" role="alert">
          {error}
        </p>
      ) : null}
      {outcome ? (
        <div
          className={outcome.ok ? 'acct-notice is-success' : 'acct-notice is-warning'}
          role="status"
        >
          <p>{outcome.message}</p>
          <small>
            配置：{outcome.metadata === 'saved' ? '已保存' : '未更改'} · 凭据：
            {outcome.credential === 'saved'
              ? '已保存'
              : outcome.credential === 'unknown'
                ? '结果不确定'
                : '未更改'}{' '}
            · 运行时：{outcome.runtime === 'synchronized' ? '已同步' : '未同步'}
          </small>
          {outcome.runtime === 'failed' && outcome.metadata === 'saved' ? (
            <p>
              刷新列表只读取配置，不修复运行时。请检查配置与权限后重新编辑保存，或重启引擎并检查模型；凭据结果不确定时先核对登录状态。
            </p>
          ) : null}
        </div>
      ) : null}
      {!form ? (
        catalog && catalog.endpoints.length > 0 ? (
          <div className="sp-card acct-endpoint-list">
            {catalog.endpoints.map((endpoint) => (
              <div className="acct-endpoint-row" key={endpoint.id}>
                <span className="acct-endpoint-icon" aria-hidden="true">
                  <Server size={15} />
                </span>
                <div className="acct-endpoint-meta">
                  <strong>{endpoint.label}</strong>
                  <small>
                    {endpoint.api ? protocols[endpoint.api] : '高级配置'} ·{' '}
                    {endpoint.modelIds.length} 个模型 · {endpoint.imageModelIds?.length ?? 0}{' '}
                    个支持图片输入
                  </small>
                  {!endpoint.editable ? (
                    <details className="acct-endpoint-details">
                      <summary>查看配置说明</summary>
                      <p>{endpoint.unsupportedReason}</p>
                      <code>{endpoint.id}</code>
                      <p>{endpoint.baseUrl ?? '地址不可展示'}</p>
                      <p>{endpoint.modelIds.join('、')}</p>
                    </details>
                  ) : null}
                </div>
                {endpoint.editable ? (
                  <button
                    type="button"
                    className="acct-button"
                    aria-label={`编辑 ${endpoint.label}`}
                    disabled={disabled}
                    onClick={() => edit(endpoint)}
                  >
                    编辑
                  </button>
                ) : (
                  <span className="acct-status">只读</span>
                )}
              </div>
            ))}
            <div className="acct-card-footer">
              <button
                type="button"
                className="acct-button"
                disabled={disabled || loading || !catalog}
                onClick={() => edit()}
              >
                <Plus size={14} />
                添加端点
              </button>
            </div>
          </div>
        ) : (
          <div className="acct-empty is-action">
            <p>
              {catalog
                ? '尚无自定义端点。添加服务地址与模型 ID 后，在模型菜单中明确选择。'
                : loading
                  ? '正在读取端点…'
                  : '端点列表暂不可用。'}
            </p>
            <button
              type="button"
              className="acct-button is-primary"
              disabled={disabled || loading || !catalog}
              onClick={() => edit()}
            >
              <Plus size={14} />
              添加端点
            </button>
          </div>
        )
      ) : (
        <form
          className="sp-card endpoint-form acct-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className="acct-form-head">
            <h3>{form.id ? '编辑端点' : '新增端点'}</h3>
            <p>填写服务地址和密钥，拉取模型后即可保存。</p>
          </div>
          <label htmlFor="endpoint-url">Base URL</label>
          <input
            id="endpoint-url"
            type="url"
            value={form.baseUrl}
            disabled={disabled}
            autoComplete="off"
            placeholder="https://api.example.com/v1"
            aria-invalid={errorField === 'baseUrl'}
            aria-describedby={`endpoint-url-help${errorField === 'baseUrl' ? ' endpoint-error' : ''}`}
            onChange={(event) => update({ baseUrl: event.target.value })}
          />
          <small id="endpoint-url-help">
            例如 https://api.example.com/v1，也支持本机服务地址。
          </small>
          <label htmlFor="endpoint-key">API Key</label>
          <input
            id="endpoint-key"
            type="password"
            value={key}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errorField === 'key'}
            aria-describedby={`endpoint-key-help${errorField === 'key' ? ' endpoint-error' : ''}`}
            onChange={(event) => {
              setKey(event.target.value)
              setDiscoveryNote('')
              setError('')
              setErrorField(null)
            }}
          />
          <small id="endpoint-key-help">
            {form.id
              ? '留空保留现有凭据；不会回显旧密钥。'
              : '仅用于此服务的认证；本地免认证服务可填任意占位值。'}
            提交或关闭时清空。
          </small>
          <button
            type="button"
            className="acct-button"
            disabled={disabled || !form.baseUrl || !key}
            onClick={() => void discover()}
          >
            <RefreshCw
              size={14}
              className={discovering ? 'endpoint-discovery-spinner' : undefined}
            />
            {discovering ? '正在拉取模型…' : '拉取模型'}
          </button>
          {discoveryNote ? (
            <p role="status" className="acct-notice">
              {discoveryNote}
            </p>
          ) : null}
          <details className="endpoint-advanced" open={form.id || ['label', 'modelIds', 'imageModelIds', 'api'].includes(errorField ?? '') ? true : undefined}>
            <summary>高级设置与模型列表{ids.length ? `（${ids.length} 个）` : ''}</summary>
            <label htmlFor="endpoint-label">显示名称</label>
            <input
              id="endpoint-label"
              placeholder="可选，默认使用服务域名"
              value={form.label}
              disabled={disabled}
              autoComplete="off"
              aria-invalid={errorField === 'label'}
              aria-describedby={errorField === 'label' ? 'endpoint-error' : undefined}
              onChange={(event) => update({ label: event.target.value })}
            />
            <label htmlFor="endpoint-api">协议</label>
            <select
              id="endpoint-api"
              value={form.api}
              disabled={disabled}
              onChange={(event) => update({ api: event.target.value as CustomEndpointApi })}
            >
              {Object.entries(protocols).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <label htmlFor="endpoint-models">模型 ID</label>
            <textarea
              id="endpoint-models"
              rows={3}
              value={form.modelIds}
              disabled={disabled}
              spellCheck={false}
              aria-invalid={errorField === 'modelIds'}
              aria-describedby={`endpoint-model-help${errorField === 'modelIds' ? ' endpoint-error' : ''}`}
              onChange={(event) => update({ modelIds: event.target.value })}
            />
            <small id="endpoint-model-help">每行一个，不重复。使用服务实际支持的模型 ID。</small>
            {ids.length ? (
              <div className="endpoint-image-models" role="group" aria-label="模型图片输入能力">
                <small>只勾选服务确实支持图片输入的模型；此设置不会自动检测服务能力。</small>
                {[...new Set(ids)].map((id) => (
                  <label key={id} className="endpoint-confirm">
                    <input
                      type="checkbox"
                      checked={form.imageModelIds.includes(id)}
                      disabled={disabled}
                      onChange={(event) =>
                        update({
                          imageModelIds: event.target.checked
                            ? [...form.imageModelIds, id]
                            : form.imageModelIds.filter((selected) => selected !== id)
                        })
                      }
                    />
                    支持图片输入：{id}
                  </label>
                ))}
              </div>
            ) : null}
          </details>
          {removed.length ? (
            <div className="acct-notice is-warning">
              <p>
                将移除：{removed.join('、')}。引用这些模型的会话会保留历史，但需要重新选择模型。
              </p>
              <label className="endpoint-confirm">
                <input
                  type="checkbox"
                  checked={confirmedRemoval}
                  disabled={disabled}
                  onChange={(event) => setConfirmedRemoval(event.target.checked)}
                />
                确认移除上述模型
              </label>
            </div>
          ) : null}
          <div className="acct-form-actions">
            <button type="button" className="acct-button" onClick={cancel}>
              取消编辑
            </button>
            <button type="submit" className="acct-button is-primary" disabled={disabled}>
              {pending ? '正在保存…' : '保存端点'}
            </button>
          </div>
        </form>
      )}
      {path ? (
        <details className="acct-storage">
          <summary>Pi 配置位置</summary>
          <code>{path}</code>
          <p>高级配置在此文件中管理。此处仅展示路径，不打开任意文件。</p>
        </details>
      ) : null}
    </section>
  )
}
