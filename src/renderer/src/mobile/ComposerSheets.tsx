import { useEffect, useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { PERMISSION_LEVELS } from './permissions'
import type { PermissionMode, ThinkingLevel } from '../../../shared/contracts'
import {
  THINKING_LABEL,
  contextLabel,
  recentModels,
  rememberModel
} from '../store/model-presentation'
import type { MobileModelOption } from '../../../shared/mobile-gateway'
import type { SkillSummary } from '../../../shared/skills'
import { Sheet } from './Sheet'

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
          {option.reasoning ? <span>推理</span> : null}
          {option.image ? <span>图片</span> : null}
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
  const needle = query.trim().toLowerCase()
  const matches = (option: MobileModelOption): boolean =>
    !needle ||
    option.name.toLowerCase().includes(needle) ||
    option.id.toLowerCase().includes(needle) ||
    (providers?.[option.provider] ?? option.provider).toLowerCase().includes(needle)
  const groups = useMemo(() => {
    const byProvider = new Map<string, MobileModelOption[]>()
    for (const option of models)
      byProvider.set(option.provider, [...(byProvider.get(option.provider) ?? []), option])
    return [...byProvider]
  }, [models])
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
  const visible = groups
    .map(([id, options]) => [id, options.filter(matches)] as const)
    .filter(([, options]) => options.length)
  return (
    <Sheet title="选择模型" onClose={onClose}>
      {thinking && thinking.available.length > 1 ? (
        <div className="m-effort">
          <span>思考强度</span>
          <div role="radiogroup" aria-label="思考强度">
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
      {models.length > 6 ? (
        <input
          className="m-sheet-search"
          type="search"
          placeholder="搜索模型或账号"
          aria-label="搜索模型"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}
      {models.length === 0 ? (
        <p className="m-empty">没有可用的模型，请在电脑上登录或配置账号。</p>
      ) : visible.length === 0 ? (
        <p className="m-empty">没有匹配的模型</p>
      ) : null}
      {!needle && recent.length > 1 ? (
        <div className="m-sheet-group">
          <p className="m-sheet-label">最近使用</p>
          {recent.map((option) => (
            <ModelOptionRow
              key={`recent:${option.provider}/${option.id}`}
              option={option}
              active={isActive(option)}
              onPick={pick}
            />
          ))}
        </div>
      ) : null}
      {visible.map(([id, options]) => (
        <div className="m-sheet-group" key={id}>
          <p className="m-sheet-label">{providers?.[id] ?? id}</p>
          {options.map((option) => (
            <ModelOptionRow
              key={`${option.provider}/${option.id}`}
              option={option}
              active={isActive(option)}
              onPick={pick}
            />
          ))}
        </div>
      ))}
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
    <Sheet title="工具权限" onClose={onClose}>
      <p className="m-sheet-note">按项目记住；桌面控制每次都会询问。</p>
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
      (reason: unknown) => live && setError(reason instanceof Error ? reason.message : '读取失败')
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
    <Sheet title="使用技能" onClose={onClose}>
      <input
        className="m-sheet-search"
        type="search"
        placeholder="搜索技能"
        aria-label="搜索技能"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error ? <p className="m-empty">{error}</p> : null}
      {!skills && !error ? <p className="m-empty">正在读取…</p> : null}
      {skills && visible.length === 0 ? (
        <p className="m-empty">{skills.length ? '没有匹配的技能' : '这个项目还没有可用的技能'}</p>
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
