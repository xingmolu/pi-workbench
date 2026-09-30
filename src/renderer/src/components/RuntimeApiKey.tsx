import { useEffect, useState } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import { commandOrigin } from '../store/pi-store'
import { useSettingsDraft } from './SettingsDraftContext'

export default function RuntimeApiKey({
  snapshot,
  providerId = 'anthropic'
}: {
  snapshot: AgentSnapshot
  providerId?: string
}): React.JSX.Element {
  const [key, setKey] = useState('')
  const [url, setUrl] = useState('')
  const [pending, setPending] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const native = snapshot.runtime?.id === 'claude'
  useSettingsDraft('runtime-api-key', Boolean(key || url))
  useEffect(() => {
    setKey('')
    setUrl('')
    setSaved(false)
    setError(null)
  }, [snapshot.runtime?.id])
  return (
    <form
      className="runtime-key-form"
      onSubmit={(event) => {
        event.preventDefault()
        setPending(true)
        setError(null)
        setSaved(false)
        void window.pi
          .send(
            {
              type: 'account:api-key:set',
              providerId,
              apiKey: key.trim(),
              ...(native && url.trim() ? { baseUrl: url.trim() } : {})
            },
            commandOrigin(snapshot)
          )
          .then(() => {
            setKey('')
            setUrl('')
            setSaved(true)
          })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => setPending(false))
      }}
    >
      <label htmlFor="runtime-api-key">API Key</label>
      <input
        id="runtime-api-key"
        type="password"
        value={key}
        autoComplete="off"
        spellCheck={false}
        placeholder="输入新的 API Key"
        onChange={(event) => {
          setKey(event.target.value)
          setSaved(false)
        }}
        disabled={pending}
      />
      {native ? (
        <>
          <label htmlFor="runtime-base-url">
            服务 URL <span>可选</span>
          </label>
          <input
            id="runtime-base-url"
            type="url"
            value={url}
            placeholder="默认使用 Anthropic"
            onChange={(event) => setUrl(event.target.value)}
            disabled={pending}
          />
        </>
      ) : null}
      <div className="runtime-key-footer">
        <span>仅保存在 {snapshot.runtime?.label ?? '当前引擎'} 的应用配置中。</span>
        <button className="primary-button" type="submit" disabled={pending || !key.trim()}>
          {pending ? (
            <LoaderCircle size={14} className="spin" />
          ) : saved ? (
            <Check size={14} />
          ) : null}
          {pending ? '保存中…' : '保存连接'}
        </button>
      </div>
      {saved ? <p role="status">连接已保存。</p> : null}
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}
