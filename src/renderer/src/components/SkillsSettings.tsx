import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, RefreshCw, Search, Sparkles } from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import type { SkillDetail, SkillSummary, SkillsCatalogSnapshot } from '../../../shared/skills'
import { skillDraftIdentity, type SkillInsertion } from '../store/skill-draft'
import '../assets/skills.css'

const scopeLabels = { user: '用户', project: '项目', temporary: '临时' }
export default function SkillsSettings({
  snapshot,
  onInsert,
  insertDisabled = false,
  compact = false
}: {
  snapshot: AgentSnapshot
  onInsert: (request: SkillInsertion) => void
  insertDisabled?: boolean
  compact?: boolean
}): React.JSX.Element {
  const [catalog, setCatalog] = useState<SkillsCatalogSnapshot | null>(null)
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [selected, setSelected] = useState<SkillSummary | null>(null)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const detailSequence = useRef(0)
  const identity = skillDraftIdentity(snapshot)
  const identityKey = JSON.stringify(identity)
  const currentIdentity = useRef(identityKey)
  currentIdentity.current = identityKey
  const [loadedIdentity, setLoadedIdentity] = useState('')

  useEffect(() => {
    let cancelled = false
    detailSequence.current++
    setCatalog(null)
    setDetail(null)
    setSelected(null)
    setError('')
    setLoadedIdentity('')
    if (!snapshot.ready || !identity) {
      setLoading(false)
      return
    }
    setLoading(true)
    void window.pi
      .send({ type: 'skills:list', sessionId: identity.sessionId, generation: identity.generation })
      .then(({ catalog }) => {
        if (cancelled || currentIdentity.current !== identityKey) return
        setCatalog(catalog)
        setLoadedIdentity(identityKey)
      })
      .catch(() => {
        if (!cancelled) setError('无法读取当前技能列表，请重试。')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      detailSequence.current++
    }
  }, [identityKey, snapshot.ready, refresh])

  const showDetail = (skill: SkillSummary): void => {
    if (!identity) return
    const sequence = ++detailSequence.current
    setSelected(skill)
    setDetail(null)
    setError('')
    setLoading(true)
    void window.pi
      .send({
        type: 'skills:detail',
        sessionId: identity.sessionId,
        generation: identity.generation,
        id: skill.id
      })
      .then(({ detail }) => {
        if (sequence === detailSequence.current && currentIdentity.current === identityKey)
          setDetail(detail)
      })
      .catch(() => {
        if (sequence === detailSequence.current && currentIdentity.current === identityKey)
          setError('无法预览：文件可能已更改、超过 64 KiB 或不是 UTF-8 文本。请刷新列表后重试。')
      })
      .finally(() => {
        if (sequence === detailSequence.current) setLoading(false)
      })
  }
  const insert = (skill: SkillSummary): void => {
    if (identity && !insertDisabled && loadedIdentity === identityKey && skill.canInsert)
      onInsert({ identity, skill })
  }
  const filtered =
    catalog?.skills.filter(
      (skill) =>
        (scope === 'all' || skill.scope === scope) &&
        `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())
    ) ?? []
  const canInsert =
    !insertDisabled &&
    snapshot.ready &&
    snapshot.modelAvailability === 'available' &&
    snapshot.composeBlockReason === null &&
    loadedIdentity === identityKey
  return (
    <section
      className={`skills-settings${compact ? ' skills-compact' : ''}`}
      aria-label={compact ? '选择技能' : '技能设置'}
    >
      <header className="skills-heading">
        <div>
          <h2>
            <Sparkles size={18} />
            Skills 技能
          </h2>
          <p>当前 Pi 运行时已加载的技能</p>
        </div>
        <button
          className="tool-chip"
          type="button"
          aria-label="刷新技能列表"
          disabled={loading || !identity || !snapshot.ready}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={14} />
          刷新
        </button>
      </header>
      {!compact && (
        <p className="skills-guide">
          用户技能位于 <code>~/.pi/agent/skills</code>、<code>~/.agents/skills</code>；项目技能位于{' '}
          <code>.pi/skills</code>、<code>.agents/skills</code>
          。这里只读取已加载列表，刷新不会重新扫描。新增或修改技能后，请重新打开项目或重建运行时。
        </p>
      )}
      {selected ? (
        <div className="skill-detail">
          <button
            type="button"
            className="tool-chip"
            onClick={() => {
              detailSequence.current++
              setSelected(null)
              setDetail(null)
              setError('')
              setLoading(false)
            }}
          >
            <ArrowLeft size={14} />
            返回列表
          </button>
          <div className="skill-detail-heading">
            <h3>{selected.name}</h3>
            <span>
              {scopeLabels[selected.scope]} · {selected.origin === 'package' ? 'Pi 包' : '技能目录'}
            </span>
          </div>
          <p>{selected.description || '未提供描述'}</p>
          <p className="skills-mode">
            {selected.mode === 'manual-only'
              ? '仅手动调用：已加载，通过 /skill: 命令使用。'
              : '模型可发现，也可通过 /skill: 命令手动调用。'}
          </p>
          <button
            type="button"
            className="tool-chip skill-insert"
            disabled={!canInsert || !selected.canInsert}
            onClick={() => insert(selected)}
          >
            插入到输入框
          </button>
          {!selected.canInsert && (
            <p className="inline-hint">名称重复或不符合安全命令格式，无法直接插入。</p>
          )}
          {loading ? (
            <p role="status">正在读取技能…</p>
          ) : (
            detail && (
              <pre className="skill-preview" aria-label="技能内容">
                {detail.preview}
              </pre>
            )
          )}
        </div>
      ) : (
        <>
          <div className="skills-filters">
            <label>
              <Search size={14} />
              <input
                aria-label="搜索技能"
                placeholder="搜索名称或描述"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <select
              aria-label="技能范围"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            >
              <option value="all">全部范围</option>
              <option value="user">用户</option>
              <option value="project">项目</option>
              <option value="temporary">临时</option>
            </select>
          </div>
          {catalog && (
            <p className="skills-count">
              {filtered.length} 个匹配 · 已加载 {catalog.total} 个
              {catalog.truncated ? '（仅显示前 256 个）' : ''}
            </p>
          )}
          {loading ? (
            <p role="status">正在读取技能列表…</p>
          ) : !identity || !snapshot.ready ? (
            <p className="skills-empty">打开项目并连接 Pi 后查看已加载技能。</p>
          ) : catalog && !filtered.length ? (
            <p className="skills-empty">
              {catalog.total
                ? '没有匹配的技能。'
                : '当前运行时未加载技能。将 SKILL.md 放入标准技能目录后，重新打开项目。'}
            </p>
          ) : (
            <div className="skills-list">
              {filtered.map((skill) => (
                <div className="skill-row" key={skill.id}>
                  <button
                    className="skill-row-main"
                    type="button"
                    onClick={() => showDetail(skill)}
                  >
                    <strong>{skill.name}</strong>
                    <span>{skill.description || '未提供描述'}</span>
                    <small>
                      {scopeLabels[skill.scope]} ·{' '}
                      {skill.origin === 'package' ? 'Pi 包' : '技能目录'} ·{' '}
                      {skill.mode === 'manual-only' ? '仅手动调用' : '模型可发现'}
                    </small>
                  </button>
                  {compact && (
                    <button
                      className="tool-chip"
                      type="button"
                      aria-label={`插入技能 ${skill.name}`}
                      disabled={!canInsert || !skill.canInsert}
                      onClick={() => insert(skill)}
                    >
                      插入
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {error && (
        <div role="alert" className="skills-error">
          <p>{error}</p>
          <button
            className="tool-chip"
            type="button"
            onClick={() => (selected ? showDetail(selected) : setRefresh((value) => value + 1))}
          >
            重试
          </button>
        </div>
      )}
      {insertDisabled && (
        <p className="inline-hint">
          当前无法插入技能；请先选择可用模型、完成编辑或发送，并移除附件。
        </p>
      )}
      <p className="skills-footnote">
        插入只会在草稿开头添加命令，不会发送。技能内容在发送时由 Pi 展开。
      </p>
    </section>
  )
}
