import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, Plus, RefreshCw, Server, Terminal, Globe } from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import {
  mcpServerSchema,
  type McpCommand,
  type McpSnapshot,
  type McpSummary
} from '../../../shared/mcp'
import { projectNavigationReason } from '../../../shared/project-catalog'
import '../assets/mcp-settings.css'

type Form = {
  id: string
  create: boolean
  transport: 'stdio' | 'http'
  command: string
  args: string
  url: string
  timeout: number
  secrets: string
  enabled: boolean
  confirmed: boolean
}
const emptyForm = (): Form => ({
  id: '',
  create: true,
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  timeout: 30000,
  secrets: '',
  enabled: false,
  confirmed: false
})
const labels: Record<McpSummary['status'], string> = {
  connected: '已连接',
  connecting: '连接中',
  error: '连接失败',
  disconnected: '未连接',
  disabled: '已停用',
  untrusted: '待确认启用',
  unsupported: '高级配置只读'
}
function parseSecrets(text: string): Record<string, string> | undefined {
  if (!text.trim()) return undefined
  const entries = text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const split = line.indexOf('=')
      if (split < 1) throw new Error('环境变量或请求头请每行填写 KEY=value。')
      return [line.slice(0, split).trim(), line.slice(split + 1)]
    })
  if (new Set(entries.map(([key]) => key)).size !== entries.length)
    throw new Error('存在重复的变量或请求头。')
  return Object.fromEntries(entries)
}
export default function McpSettings({ snapshot }: { snapshot: AgentSnapshot }): React.JSX.Element {
  const [catalog, setCatalog] = useState<McpSnapshot | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [unknown, setUnknown] = useState(false)
  const [confirm, setConfirm] = useState<McpSummary | null>(null)
  const epoch = useRef(0)
  const lock = useRef(false)
  const identity = { sessionId: snapshot.sessionId, generation: snapshot.generation }
  const blocked =
    projectNavigationReason(snapshot) ?? (snapshot.edit?.pending ? '请先完成编辑' : null)
  const run = async (command: McpCommand) => {
    if (lock.current) return
    lock.current = true
    setPending(true)
    setError('')
    const attempt = ++epoch.current
    try {
      const response = await window.pi.send(command)
      if (attempt !== epoch.current) return
      setCatalog(response.result)
      setUnknown(false)
      if (command.type !== 'mcp:list') {
        setForm(null)
        setConfirm(null)
      }
    } catch {
      if (attempt !== epoch.current) return
      setUnknown(command.type !== 'mcp:list')
      setError(
        command.type === 'mcp:list'
          ? '读取失败，请刷新重试。'
          : '操作未确认完成。请刷新列表核对，不要直接重复提交。'
      )
    } finally {
      if (attempt === epoch.current) {
        lock.current = false
        setPending(false)
      }
    }
  }
  useEffect(() => {
    void run({ type: 'mcp:list' })
    return () => {
      epoch.current++
      lock.current = false
    }
  }, [])
  const edit = (server: McpSummary) =>
    setForm({
      id: server.id,
      create: false,
      transport: server.transport === 'http' ? 'http' : 'stdio',
      command: server.command ?? '',
      args: (server.args ?? []).join('\n'),
      url: server.url ?? '',
      timeout: server.timeout ?? 30000,
      secrets: '',
      enabled: server.enabled,
      confirmed: false
    })
  const save = () => {
    if (!form || !catalog || lock.current) return
    try {
      const secrets = parseSecrets(form.secrets)
      const server = mcpServerSchema.parse({
        timeout: form.timeout,
        ...(form.transport === 'stdio'
          ? {
              command: form.command,
              args: form.args ? form.args.split('\n') : [],
              ...(secrets ? { env: secrets } : {})
            }
          : { url: form.url, ...(secrets ? { headers: secrets } : {}) })
      })
      if (form.enabled && !form.confirmed) {
        setError('启用前请确认本机执行与网络访问风险。')
        return
      }
      setForm({ ...form, secrets: '' })
      void run({
        type: 'mcp:save',
        ...identity,
        revision: catalog.revision,
        id: form.id,
        create: form.create,
        server,
        enabled: form.enabled
      })
    } catch {
      setError(
        '配置无效。检查名称、命令/URL、超时及 KEY=value 格式；HTTP 仅支持 HTTPS 或本机地址。'
      )
    }
  }
  return (
    <section className="mcp-settings" aria-label="MCP 服务器设置">
      <header className="settings-section-title">
        <div>
          <h2>MCP 服务器</h2>
          <small>用户配置 · Pi 扩展桥</small>
        </div>
        <button
          className="secondary-button"
          disabled={pending}
          onClick={() => void run({ type: 'mcp:list' })}
        >
          <RefreshCw size={14} />
          刷新列表
        </button>
      </header>
      <p className="inline-hint">
        通过官方 MCP SDK 接入 Pi。配置位于 ~/.pi/agent/mcp.json，不自动导入其他应用或项目配置。
      </p>
      {error && (
        <p role="alert" className="mcp-message">
          {error}
        </p>
      )}
      {catalog?.message && (
        <p role="status" className="mcp-message">
          {catalog.message}
        </p>
      )}
      {blocked && <p role="status">{blocked}；当前仅可查看配置。</p>}
      {form ? (
        <form
          className="mcp-form"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <button
            type="button"
            className="secondary-button"
            disabled={pending}
            onClick={() => {
              setForm(null)
              setError('')
            }}
          >
            <ChevronLeft size={14} />
            返回列表
          </button>
          <h3>{form.create ? '新建 MCP 服务器' : `编辑 ${form.id}`}</h3>
          <label>
            名称
            <input
              required
              pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"
              value={form.id}
              disabled={!form.create || pending}
              placeholder="my-mcp-server"
              onChange={(event) => setForm({ ...form, id: event.target.value })}
            />
          </label>
          <label>
            连接类型
            <select
              value={form.transport}
              disabled={pending}
              onChange={(event) =>
                setForm({
                  ...form,
                  transport: event.target.value as Form['transport'],
                  secrets: '',
                  confirmed: false
                })
              }
            >
              <option value="stdio">stdio · 本地命令</option>
              <option value="http">Streamable HTTP · 远程服务</option>
            </select>
          </label>
          {form.transport === 'stdio' ? (
            <>
              <label>
                命令
                <input
                  required
                  placeholder="npx 或可执行文件的绝对路径"
                  value={form.command}
                  disabled={pending}
                  onChange={(event) =>
                    setForm({ ...form, command: event.target.value, confirmed: false })
                  }
                />
              </label>
              <label>
                参数 · 每行一个
                <textarea
                  value={form.args}
                  disabled={pending}
                  onChange={(event) =>
                    setForm({ ...form, args: event.target.value, confirmed: false })
                  }
                  placeholder={'-y\n@modelcontextprotocol/server-memory'}
                />
              </label>
            </>
          ) : (
            <label>
              服务 URL
              <input
                required
                type="url"
                value={form.url}
                disabled={pending}
                onChange={(event) =>
                  setForm({ ...form, url: event.target.value, confirmed: false })
                }
                placeholder="https://example.com/mcp"
              />
            </label>
          )}
          <label>
            超时时间（毫秒）
            <input
              type="number"
              min={1000}
              max={60000}
              required
              value={form.timeout}
              disabled={pending}
              onChange={(event) => setForm({ ...form, timeout: Number(event.target.value) })}
            />
          </label>
          <label>
            {form.transport === 'stdio' ? '环境变量' : '请求头'} · 每行 KEY=value
            <textarea
              value={form.secrets}
              disabled={pending}
              autoComplete="off"
              spellCheck={false}
              className="mcp-secret-input"
              onChange={(event) =>
                setForm({ ...form, secrets: event.target.value, confirmed: false })
              }
              placeholder="留空保留已有值；填写后替换此组配置"
            />
          </label>
          <p className="inline-hint">
            已有秘密值不回显；不要把令牌放进命令参数或
            URL。秘密保存在权限受限的本地配置文件中，不是系统钥匙串。
          </p>
          <label className="mcp-check">
            <input
              type="checkbox"
              checked={form.enabled}
              disabled={pending}
              onChange={(event) =>
                setForm({ ...form, enabled: event.target.checked, confirmed: false })
              }
            />
            保存后启用
          </label>
          {form.enabled && (
            <label className="mcp-check">
              <input
                type="checkbox"
                required
                checked={form.confirmed}
                disabled={pending}
                onChange={(event) => setForm({ ...form, confirmed: event.target.checked })}
              />
              我信任此服务器，允许它以本机用户权限运行或访问所填网络地址；Ask 只保护 agent
              的工具调用，不限制启动行为。
            </label>
          )}
          <button
            className="primary-button"
            type="submit"
            disabled={pending || unknown || !!blocked || !catalog?.writable}
          >
            {pending ? '保存与连接中…' : '保存服务器'}
          </button>
        </form>
      ) : (
        <>
          <div className="mcp-toolbar">
            <input
              aria-label="搜索 MCP 服务器"
              placeholder="搜索服务器…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button
              className="secondary-button"
              disabled={pending || unknown || !!blocked || !catalog?.writable}
              onClick={() => {
                setForm(emptyForm())
                setError('')
              }}
            >
              <Plus size={14} />
              新建
            </button>
            <button
              className="secondary-button"
              disabled={pending || unknown || !!blocked || !snapshot.project || !catalog?.writable}
              onClick={() => void run({ type: 'mcp:reload', ...identity })}
            >
              重新连接
            </button>
          </div>
          {!catalog ? (
            <p role="status">{pending ? '读取服务器配置…' : '尚未读取配置'}</p>
          ) : !catalog.servers.length ? (
            <div className="mcp-empty">
              <Server size={24} />
              <h3>还没有 MCP 服务器</h3>
              <p>添加本地命令或远程服务，让 agent 使用它提供的工具。</p>
            </div>
          ) : (
            catalog.servers
              .filter((server) => server.id.toLowerCase().includes(query.toLowerCase()))
              .map((server) => (
                <article className="mcp-server" key={server.id}>
                  <div className="mcp-server-head">
                    {server.transport === 'stdio' ? <Terminal size={18} /> : <Globe size={18} />}
                    <strong>{server.id}</strong>
                    <span className={`mcp-state is-${server.status}`}>{labels[server.status]}</span>
                  </div>
                  <p>{server.command ?? server.url ?? '本版不支持的高级配置'}</p>
                  <small>
                    {server.toolCount} 个工具
                    {server.envKeys.length ? ` · 环境变量：${server.envKeys.join(', ')}` : ''}
                    {server.headerKeys.length ? ` · 请求头：${server.headerKeys.join(', ')}` : ''}
                  </small>
                  {server.message && <p role="status">{server.message}</p>}
                  <div className="mcp-row-actions">
                    <button
                      className="secondary-button"
                      disabled={pending || unknown || !!blocked || !server.editable}
                      onClick={() => edit(server)}
                    >
                      编辑
                    </button>
                    <button
                      className="secondary-button"
                      disabled={pending || unknown || !!blocked || !server.editable}
                      onClick={() =>
                        server.enabled
                          ? void run({
                              type: 'mcp:toggle',
                              ...identity,
                              id: server.id,
                              revision: catalog.revision,
                              enabled: false
                            })
                          : setConfirm(server)
                      }
                    >
                      {server.enabled ? '停用' : '启用'}
                    </button>
                  </div>
                  {confirm?.id === server.id && (
                    <div className="mcp-confirm">
                      <p>
                        启用 {server.id} 会允许本机命令启动或连接该网络地址。仅启用你信任的服务器。
                      </p>
                      <button
                        className="primary-button"
                        disabled={pending}
                        onClick={() =>
                          void run({
                            type: 'mcp:toggle',
                            ...identity,
                            id: server.id,
                            revision: catalog.revision,
                            enabled: true
                          })
                        }
                      >
                        确认信任并启用
                      </button>
                      <button
                        className="secondary-button"
                        disabled={pending}
                        onClick={() => setConfirm(null)}
                      >
                        取消
                      </button>
                    </div>
                  )}
                </article>
              ))
          )}
        </>
      )}
      <p className="inline-hint">
        当前支持文本工具；不支持 MCP Apps、资源/提示模板、远程 OAuth 或 JSON
        批量导入。服务错误不会显示为成功；停止工具调用会关闭连接，可显式重新连接。
      </p>
    </section>
  )
}
