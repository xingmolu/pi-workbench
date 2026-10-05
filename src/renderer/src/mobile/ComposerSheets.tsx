import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, ChevronRight } from 'lucide-react'
import { PERMISSION_LEVELS } from './permissions'
import type { PermissionMode, ThinkingLevel } from '../../../shared/contracts'
import {
  THINKING_LABEL,
  contextLabel,
  groupModelsByFamily,
  modelFamily,
  recentModels,
  rememberModel
} from '../store/model-presentation'
import type { MobileModelOption } from '../../../shared/mobile-gateway'
import type { SkillSummary } from '../../../shared/skills'
import { Sheet } from './Sheet'
import { t } from '../../../shared/i18n'

function ModelOptionRow({
  option,
  active,
  onPick
}: {
  option: MobileModelOption
  active: boolean
  onPick: (option: MobileModelOption) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`m-option m-model${active ? ' is-on' : ''}`}
      aria-pressed={active}
      disabled={Boolean(option.unavailableReason)}
      onClick={() => onPick(option)}
    >
      <span className="m-option-text">
        <strong>{option.name || option.id}</strong>
        <small>
          {option.unavailableReason ?? (option.name && option.name !== option.id ? option.id : '')}
        </small>
      </span>
      {!option.unavailableReason ? (
        <span className="m-model-meta">
          {option.reasoning ? <span>{t('推理')}</span> : null}
          {option.image ? <span>{t('图片')}</span> : null}
          {option.contextWindow ? (
            <span className="m-model-context">{contextLabel(option.contextWindow)}</span>
          ) : null}
        </span>
      ) : null}
      <span className="m-model-check">
        {active ? <Check size={16} aria-hidden="true" /> : null}
      </span>
    </button>
  )
}

/** Model and reasoning effort in one sheet: effort belongs to the chosen model. */
export function ModelSheet({
  models,
  providers,
  provider,
  model,
  thinking,
  onPick,
  onThinking,
  onClose
}: {
  models: MobileModelOption[]
  providers: Record<string, string> | undefined
  provider: string | null | undefined
  model: string | null | undefined
  thinking: { level: ThinkingLevel; available: ThinkingLevel[] } | null | undefined
  onPick: (option: MobileModelOption) => void
  onThinking: (level: ThinkingLevel) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const byProvider = new Map<string, MobileModelOption[]>()
    for (const option of models)
      byProvider.set(option.provider, [...(byProvider.get(option.provider) ?? []), option])
    return [...byProvider]
  }, [models])
  // With one account the sheet opens inside it; otherwise accounts come first.
  const only = groups.length === 1 ? groups[0][0] : null
  const [scope, setScope] = useState<string | null>(null)
  const browsing = scope ?? only
  const familyOf = (id: string | null): string => {
    const options = groups.find(([key]) => key === id)?.[1] ?? []
    const active = options.find((option) => option.provider === provider && option.id === model)
    return active ? modelFamily(active).id : (groupModelsByFamily(options)[0]?.id ?? '')
  }
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([familyOf(only)]))
  const enter = (id: string | null): void => {
    setQuery('')
    setScope(id)
    setExpanded(new Set([familyOf(id ?? only)]))
  }
  const label = (id: string): string => providers?.[id] ?? id
  const needle = query.trim().toLowerCase()
  const matches = (option: MobileModelOption): boolean =>
    needle
      .split(/\s+/)
      .every(
        (word) =>
          option.name.toLowerCase().includes(word) ||
          option.id.toLowerCase().includes(word) ||
          label(option.provider).toLowerCase().includes(word)
      )
  const recent = useMemo(
    () =>
      recentModels()
        .map((key) => models.find((option) => `${option.provider}:${option.id}` === key))
        .filter((option): option is MobileModelOption =>
          Boolean(option && !option.unavailableReason)
        )
        .slice(0, 3),
    [models]
  )
  const isActive = (option: MobileModelOption): boolean =>
    option.provider === provider && option.id === model
  const pick = (option: MobileModelOption): void => {
    rememberModel(option.provider, option.id)
    onPick(option)
  }
  const row = (
    option: MobileModelOption,
    key = `${option.provider}/${option.id}`
  ): React.JSX.Element => (
    <ModelOptionRow key={key} option={option} active={isActive(option)} onPick={pick} />
  )
  const scoped = groups.find(([id]) => id === browsing)?.[1] ?? []
  const visible = groups
    .map(([id, options]) => [id, options.filter(matches)] as const)
    .filter(([, options]) => options.length)
  const searchable = (browsing ? scoped.length : models.length) > 6
  return (
    <Sheet title={t('选择模型')} onClose={onClose}>
      {thinking && thinking.available.length > 1 ? (
        <div className="m-effort">
          <span>{t('思考强度')}</span>
          <div role="radiogroup" aria-label={t('思考强度')}>
            {thinking.available.map((level) => (
              <button
                type="button"
                role="radio"
                key={level}
                aria-checked={thinking.level === level}
                onClick={() => onThinking(level)}
              >
                {THINKING_LABEL[level]}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {browsing && !only ? (
        <button type="button" className="m-model-scope" onClick={() => enter(null)}>
          <ArrowLeft size={16} aria-hidden="true" />
          <strong>{label(browsing)}</strong>
          <small>{scoped.length}</small>
          <span className="sr-only">{t('返回账号列表')}</span>
        </button>
      ) : null}
      {searchable ? (
        <input
          className="m-sheet-search"
          type="search"
          placeholder={
            browsing && !only
              ? t('搜索 {label} 的模型', { label: label(browsing) })
              : t('搜索模型或账号')
          }
          aria-label={t('搜索模型')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}
      {models.length === 0 ? (
        <p className="m-empty">{t('没有可用的模型，请在电脑上登录或配置账号。')}</p>
      ) : (browsing ? !scoped.some(matches) : visible.length === 0) ? (
        <p className="m-empty">{t('没有匹配的模型')}</p>
      ) : null}
      {browsing ? (
        groupModelsByFamily(scoped).map((family) => {
          const options = family.models.filter(matches)
          if (!options.length) return null
          if (!family.label)
            return <div key={family.id}>{options.map((option) => row(option))}</div>
          const open = Boolean(needle) || expanded.has(family.id)
          return (
            <div className="m-sheet-group" key={family.id}>
              <button
                type="button"
                className="m-model-family"
                aria-expanded={open}
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(family.id)) next.delete(family.id)
                    else next.add(family.id)
                    return next
                  })
                }
              >
                <ChevronRight size={14} aria-hidden="true" />
                <span>{family.label}</span>
                <small>{options.length}</small>
              </button>
              {open ? options.map((option) => row(option)) : null}
            </div>
          )
        })
      ) : needle ? (
        // Searching from the account list looks through every account's models.
        visible.map(([id, options]) => (
          <div className="m-sheet-group" key={id}>
            <p className="m-sheet-label">{label(id)}</p>
            {options.map((option) => row(option))}
          </div>
        ))
      ) : (
        <>
          {recent.length > 1 ? (
            <div className="m-sheet-group">
              <p className="m-sheet-label">{t('最近使用')}</p>
              {recent.map((option) => row(option, `recent:${option.provider}/${option.id}`))}
            </div>
          ) : null}
          <div className="m-sheet-group">
            <p className="m-sheet-label">{t('账号')}</p>
            {groups.map(([id, options]) => {
              const active = options.find(isActive)
              return (
                <button
                  type="button"
                  key={id}
                  className={`m-option m-model${active ? ' is-on' : ''}`}
                  onClick={() => enter(id)}
                >
                  <span className="m-option-text">
                    <strong>{label(id)}</strong>
                    <small>{active ? active.name || active.id : ''}</small>
                  </span>
                  <span className="m-model-meta">
                    <span className="m-model-context">{options.length}</span>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              )
            })}
          </div>
        </>
      )}
    </Sheet>
  )
}

export function PermissionSheet({
  mode,
  onPick,
  onClose
}: {
  mode: PermissionMode | undefined
  onPick: (mode: PermissionMode) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <Sheet title={t('工具权限')} onClose={onClose}>
      <p className="m-sheet-note">{t('按项目记住；桌面控制每次都会询问。')}</p>
      {PERMISSION_LEVELS.map((level) => {
        const Icon = level.icon
        const active = level.mode === (mode ?? 'ask')
        return (
          <button
            type="button"
            key={level.mode}
            className={`m-option${active ? ' is-on' : ''}${level.mode === 'open' ? ' is-risky' : ''}`}
            aria-pressed={active}
            onClick={() => onPick(level.mode)}
          >
            <Icon size={18} aria-hidden="true" />
            <span className="m-option-text">
              <strong>{level.title}</strong>
              <small>{level.description}</small>
            </span>
            {active ? <Check size={16} aria-hidden="true" /> : null}
          </button>
        )
      })}
    </Sheet>
  )
}

export function SkillSheet({
  load,
  onPick,
  onClose
}: {
  load: () => Promise<SkillSummary[]>
  onPick: (skill: SkillSummary) => void
  onClose: () => void
}): React.JSX.Element {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => {
    let live = true
    load().then(
      (value) => live && setSkills(value),
      (reason: unknown) =>
        live && setError(reason instanceof Error ? reason.message : t('读取失败'))
    )
    return () => {
      live = false
    }
  }, [load])
  const needle = query.trim().toLowerCase()
  const visible = (skills ?? []).filter(
    (skill) =>
      !needle || skill.name.includes(needle) || skill.description.toLowerCase().includes(needle)
  )
  return (
    <Sheet title={t('使用技能')} onClose={onClose}>
      <input
        className="m-sheet-search"
        type="search"
        placeholder={t('搜索技能')}
        aria-label={t('搜索技能')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error ? <p className="m-empty">{error}</p> : null}
      {!skills && !error ? <p className="m-empty">{t('正在读取…')}</p> : null}
      {skills && visible.length === 0 ? (
        <p className="m-empty">
          {skills.length ? t('没有匹配的技能') : t('这个项目还没有可用的技能')}
        </p>
      ) : null}
      {visible.map((skill) => (
        <button type="button" key={skill.id} className="m-option" onClick={() => onPick(skill)}>
          <span className="m-option-text">
            <strong>/{skill.name}</strong>
            <small>{skill.description}</small>
          </span>
        </button>
      ))}
    </Sheet>
  )
}
