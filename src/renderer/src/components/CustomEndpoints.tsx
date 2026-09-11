import { useEffect, useRef, useState } from 'react'
import type { AgentSnapshot } from '../../../shared/contracts'
import {
  createCustomEndpointSchema,
  customEndpointSchema,
  type CustomEndpointApi,
  type CustomEndpointConfigSnapshot,
  type CustomEndpointMetadata,
  type CustomEndpointSaveResult
} from '../../../shared/custom-endpoints'
import { endpointContext } from '../store/pi-store'

const protocols: Record<CustomEndpointApi, string> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages'
}
type Form = {
  id?: string
  label: string
  api: CustomEndpointApi
  baseUrl: string
  modelIds: string
  originalIds: string[]
}
const emptyForm = (): Form => ({
  label: '',
  api: 'openai-completions',
  baseUrl: '',
  modelIds: '',
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
  const [loading, setLoading] = useState(false)
  const [confirmedRemoval, setConfirmedRemoval] = useState(false)
  const epoch = useRef(0)
  const mounted = useRef(false)
  const submitting = useRef(false)
  const context = endpointContext(snapshot)
  const identity = JSON.stringify(context)
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const loginActive = !['idle', 'success', 'error'].includes(snapshot.login.phase)
  const disabled = !snapshot.ready || snapshot.busy || loginActive || pending || loading

  const refresh = async (): Promise<void> => {
    const operation = ++epoch.current
    setForm(null)
    setKey('')
    setError('')
    setErrorField(null)
    setOutcome(null)
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
    setKey('')
    setError('')
    setErrorField(null)
    setOutcome(null)
    setConfirmedRemoval(false)
    setForm(
      endpoint
        ? {
            id: endpoint.id,
            label: endpoint.label,
            api: endpoint.api!,
            baseUrl: endpoint.baseUrl!,
            modelIds: endpoint.modelIds.join('\n'),
            originalIds: endpoint.modelIds
          }
        : emptyForm()
    )
  }
  const cancel = (): void => {
    epoch.current += 1
    setForm(null)
    setKey('')
    setError('')
    setConfirmedRemoval(false)
  }
  const update = (value: Partial<Form>): void => {
    setForm((current) => (current ? { ...current, ...value } : null))
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

  const save = async (): Promise<void> => {
    if (!form || !catalog || disabled || submitting.current) return
    const input = {
      label: form.label,
      api: form.api,
      baseUrl: form.baseUrl,
      modelIds: ids,
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
      if (response.result.metadata === 'saved') setForm(null)
    } catch {
      if (
        mounted.current &&
        operation === epoch.current &&
        capturedIdentity === currentIdentity.current
      ) {
        setForm(null)
        setError('保存结果未知，端点可能已写入。请刷新列表核对后再编辑；密钥已清空，不会自动重试。')
      }
    } finally {
      submitting.current = false
      if (mounted.current) setPending(false)
    }
  }

  return (
    <section className="settings-section custom-endpoints" aria-label="自定义端点">
      <div className="settings-section-title">
        <div>
          <span>自定义端点</span>
          <small>OpenAI / Anthropic 兼容 API</small>
        </div>
        <button
          type="button"
          className="plugin-reload-button"
          disabled={pending || loading || !snapshot.ready}
          onClick={() => void refresh()}
        >
          刷新列表
        </button>
      </div>
      <p className="endpoint-note">
        全局设置：修改影响所有工作区及 Pi CLI。新端点不会自动成为当前模型。
      </p>
      <p className="endpoint-note">密钥只填入 API Key 密码框，不要放入名称、地址或模型 ID。</p>
      {snapshot.busy || loginActive ? (
        <p className="endpoint-warning" role="note">
          {loginActive
            ? '登录正在进行，完成后才能保存端点。'
            : '会话正在运行，结束后才能保存端点。'}
        </p>
      ) : null}
      {error ? (
        <p id="endpoint-error" className="endpoint-error" role="alert">
          {error}
        </p>
      ) : null}
      {outcome ? (
        <div className={outcome.ok ? 'endpoint-result' : 'endpoint-warning'} role="status">
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
        <>
          <div className="endpoint-list">
            {catalog?.endpoints.map((endpoint) => (
              <div className="endpoint-row" key={endpoint.id}>
                <div>
                  <strong>{endpoint.label}</strong>
                  <small>
                    {endpoint.api ? protocols[endpoint.api] : '高级配置'} ·{' '}
                    {endpoint.modelIds.length} 个模型
                  </small>
                </div>
                {endpoint.editable ? (
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label={`编辑 ${endpoint.label}`}
                    disabled={disabled}
                    onClick={() => edit(endpoint)}
                  >
                    编辑
                  </button>
                ) : (
                  <span>只读</span>
                )}
                {!endpoint.editable ? (
                  <details>
                    <summary>查看配置说明</summary>
                    <p>{endpoint.unsupportedReason}</p>
                    <code>{endpoint.id}</code>
                    <p>{endpoint.baseUrl ?? '地址不可展示'}</p>
                    <p>{endpoint.modelIds.join('、')}</p>
                  </details>
                ) : null}
              </div>
            ))}
          </div>
          {catalog?.endpoints.length === 0 ? (
            <p className="endpoint-note">
              尚无自定义端点。添加服务地址与模型 ID 后，在模型菜单中明确选择。
            </p>
          ) : null}
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || loading || !catalog}
            onClick={() => edit()}
          >
            添加端点
          </button>
        </>
      ) : (
        <form
          className="endpoint-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label htmlFor="endpoint-label">显示名称</label>
          <input
            id="endpoint-label"
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
          <small id="endpoint-url-help">服务根地址；只允许 HTTPS 或显式本机 HTTP。</small>
          {form.baseUrl.toLowerCase().startsWith('http:') ? (
            <p className="endpoint-warning">
              本机 HTTP 使用明文传输，包括 API Key。仅在你信任的本机服务使用。
            </p>
          ) : null}
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
              setError('')
              setErrorField(null)
            }}
          />
          <small id="endpoint-key-help">
            {form.id
              ? '留空保留现有凭据；不会回显旧密钥。'
              : '必填；无需认证的本地服务也请填写明确占位值。'}
            提交或关闭时清空。
          </small>
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
          {removed.length ? (
            <div className="endpoint-warning">
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
          <div className="endpoint-actions">
            <button type="submit" className="primary-button" disabled={disabled}>
              {pending ? '正在保存…' : '保存端点'}
            </button>
            <button type="button" className="secondary-button" onClick={cancel}>
              取消编辑
            </button>
          </div>
        </form>
      )}
      {path ? (
        <details className="endpoint-storage">
          <summary>Pi 配置位置</summary>
          <code>{path}</code>
          <p>高级配置在此文件中管理。此处仅展示路径，不打开任意文件。</p>
        </details>
      ) : null}
    </section>
  )
}
