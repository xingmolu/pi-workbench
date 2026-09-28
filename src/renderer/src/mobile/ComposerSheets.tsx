import { useEffect, useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { PERMISSION_LEVELS } from './permissions'
import type { PermissionMode } from '../../../shared/contracts'
import type { MobileModelOption } from '../../../shared/mobile-gateway'
import type { SkillSummary } from '../../../shared/skills'
import { Sheet } from './Sheet'

export function ModelSheet({
  models,
  provider,
  model,
  onPick,
  onClose
}: {
  models: MobileModelOption[]
  provider: string | null | undefined
  model: string | null | undefined
  onPick: (option: MobileModelOption) => void
  onClose: () => void
}): React.JSX.Element {
  const groups = useMemo(() => {
    const byProvider = new Map<string, MobileModelOption[]>()
    for (const option of models)
      byProvider.set(option.provider, [...(byProvider.get(option.provider) ?? []), option])
    return [...byProvider]
  }, [models])
  return (
    <Sheet title="选择模型" onClose={onClose}>
      {groups.length === 0 ? (
        <p className="m-empty">没有可用的模型，请在桌面端登录或配置。</p>
      ) : null}
      {groups.map(([name, options]) => (
        <div className="m-sheet-group" key={name}>
          <p className="m-sheet-label">{name}</p>
          {options.map((option) => {
            const active = option.provider === provider && option.id === model
            return (
              <button
                type="button"
                key={`${option.provider}/${option.id}`}
                className={`m-option${active ? ' is-on' : ''}`}
                aria-pressed={active}
                disabled={Boolean(option.unavailableReason)}
                onClick={() => onPick(option)}
              >
                <span className="m-option-text">
                  <strong>{option.name || option.id}</strong>
                  <small>
                    {option.unavailableReason ?? (option.image ? '支持图片' : option.id)}
                  </small>
                </span>
                {active ? <Check size={16} aria-hidden="true" /> : null}
              </button>
            )
          })}
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
