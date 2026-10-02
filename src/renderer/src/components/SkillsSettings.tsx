import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FileText,
  RefreshCw,
  Search,
  Sparkles
} from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import type { SkillDetail, SkillSummary, SkillsCatalogSnapshot } from '../../../shared/skills'
import { skillDraftIdentity, type SkillInsertion } from '../store/skill-draft'
import { t } from '../../../shared/i18n'
import '../assets/skills.css'

const scopeLabels = { user: t('用户'), project: t('项目'), temporary: t('临时') }
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
        if (!cancelled) setError(t('无法读取当前技能列表，请重试。'))
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
          setError(t('无法预览：文件可能已更改、超过 64 KiB 或不是 UTF-8 文本。请刷新列表后重试。'))
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
  const sourceLabel = (skill: SkillSummary): string =>
    skill.origin === 'package' ? t('Pi 包') : t('技能目录')
  return (
    <section
      className={`skills-settings${compact ? ' skills-compact' : ''}`}
      aria-label={compact ? t('选择技能') : t('技能设置')}
    >
      <header className="skills-heading">
        <div>
          <h2>
            <Sparkles size={18} />

            {t('Skills 技能')}
          </h2>
          <p>
            {t('Agent 按需读取的 SKILL.md 说明。模型可以自行发现，也可以用 /skill: 手动调用。')}
          </p>
        </div>
        <button
          className="skills-refresh"
          type="button"
          aria-label={t('刷新技能列表')}
          title={t('刷新技能列表')}
          disabled={loading || !identity || !snapshot.ready}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={14} className={loading ? 'spin' : undefined} />

          {t('刷新')}
        </button>
      </header>
      {selected ? (
        <div className="skill-detail">
          <button
            type="button"
            className="skills-back"
            onClick={() => {
              detailSequence.current++
              setSelected(null)
              setDetail(null)
              setError('')
              setLoading(false)
            }}
          >
            <ArrowLeft size={14} />

            {t('返回列表')}
          </button>
          <div className="skill-detail-card">
            <div className="skill-detail-heading">
              <span className="skill-tile" aria-hidden="true">
                <Sparkles size={15} />
              </span>
              <div>
                <h3>{selected.name}</h3>
                <p>{selected.description || t('未提供描述')}</p>
                <div className="skill-badges">
                  <span className="skill-badge">{scopeLabels[selected.scope]}</span>
                  <span className="skill-badge">{sourceLabel(selected)}</span>
                  <span
                    className={`skill-badge${selected.mode === 'manual-only' ? ' is-manual' : ''}`}
                  >
                    {selected.mode === 'manual-only' ? t('仅手动调用') : t('模型可发现')}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="skill-insert"
                disabled={!canInsert || !selected.canInsert}
                onClick={() => insert(selected)}
              >
                {t('插入到输入框')}
              </button>
            </div>
            <p className="skills-mode">
              {selected.mode === 'manual-only'
                ? t('仅手动调用：已加载，通过 /skill: 命令使用；模型不会自行选用。')
                : t('模型会在需要时自行选用，也可以通过 /skill: 命令手动调用。')}
            </p>
            {!selected.canInsert && (
              <p className="inline-hint">{t('名称重复或不符合安全命令格式，无法直接插入。')}</p>
            )}
          </div>
          {loading ? (
            <p role="status" className="skills-loading">
              {t('正在读取技能…')}
            </p>
          ) : (
            detail && (
              <div className="skill-preview-card">
                <div className="skill-preview-title">
                  <FileText size={13} aria-hidden="true" />
                  SKILL.md
                </div>
                <pre className="skill-preview" aria-label={t('技能内容')}>
                  {detail.preview}
                </pre>
              </div>
            )
          )}
        </div>
      ) : (
        <>
          <div className="skills-filters">
            <label>
              <Search size={14} />
              <input
                aria-label={t('搜索技能')}
                placeholder={t('搜索名称或描述')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <span className="skills-scope">
              <select
                aria-label={t('技能范围')}
                value={scope}
                onChange={(event) => setScope(event.target.value)}
              >
                <option value="all">{t('全部范围')}</option>
                <option value="user">{t('用户')}</option>
                <option value="project">{t('项目')}</option>
                <option value="temporary">{t('临时')}</option>
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </span>
          </div>
          {catalog && (
            <p className="skills-count">
              {t('{length} 个匹配 · 已加载 {total} 个', {
                length: filtered.length,
                total: catalog.total
              })}
              {catalog.truncated ? t('（仅显示前 256 个）') : ''}
            </p>
          )}
          {loading ? (
            <p role="status" className="skills-loading">
              {t('正在读取技能列表…')}
            </p>
          ) : !identity || !snapshot.ready ? (
            <div className="skills-empty">
              <Sparkles size={20} aria-hidden="true" />
              <span>{t('打开项目并连接 Pi 后查看已加载技能。')}</span>
            </div>
          ) : catalog && !filtered.length ? (
            <div className="skills-empty">
              <Sparkles size={20} aria-hidden="true" />
              <span>
                {catalog.total
                  ? t('没有匹配的技能。')
                  : t('当前运行时未加载技能。将 SKILL.md 放入下方的技能目录后，重新打开项目。')}
              </span>
            </div>
          ) : (
            <div className="skills-list">
              {filtered.map((skill) => (
                <div className="skill-row" key={skill.id}>
                  <button
                    className="skill-row-main"
                    type="button"
                    onClick={() => showDetail(skill)}
                  >
                    <span className="skill-tile" aria-hidden="true">
                      <Sparkles size={14} />
                    </span>
                    <span className="skill-row-text">
                      <strong>{skill.name}</strong>
                      <span>{skill.description || t('未提供描述')}</span>
                    </span>
                    <span className="skill-badges">
                      <span className="skill-badge">{scopeLabels[skill.scope]}</span>
                      <span
                        className={`skill-badge${skill.mode === 'manual-only' ? ' is-manual' : ''}`}
                      >
                        {skill.mode === 'manual-only' ? t('仅手动调用') : t('模型可发现')}
                      </span>
                    </span>
                    <ChevronRight size={15} className="skill-row-chevron" aria-hidden="true" />
                  </button>
                  {compact && (
                    <button
                      className="tool-chip"
                      type="button"
                      aria-label={t('插入技能 {name}', { name: skill.name })}
                      disabled={!canInsert || !skill.canInsert}
                      onClick={() => insert(skill)}
                    >
                      {t('插入')}
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
            className="skills-refresh"
            type="button"
            onClick={() => (selected ? showDetail(selected) : setRefresh((value) => value + 1))}
          >
            {t('重试')}
          </button>
        </div>
      )}
      {insertDisabled && (
        <p className="inline-hint">
          {t('当前无法插入技能；请先选择可用模型、完成编辑或发送，并移除附件。')}
        </p>
      )}
      {!compact && (
        <div className="skills-guide">
          <p>
            <strong>{t('技能目录')}</strong> {t('用户：')}
            <code>~/.pi/agent/skills</code>、<code>~/.agents/skills</code>
            {t('；项目：')}
            <code>.pi/skills</code>、<code>.agents/skills</code>。
          </p>
          <p>
            {t(
              '这里只读取已加载列表，刷新不会重新扫描；新增或修改技能后，请重新打开项目或重建运行时。插入只会在草稿开头添加命令，不会发送，技能内容在发送时由 Pi 展开。'
            )}
          </p>
        </div>
      )}
    </section>
  )
}
