import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useId,
  useRef,
  useState,
  type KeyboardEvent
} from 'react'
import type { AgentSnapshot } from '../../../shared/contracts'
import type { SkillSummary } from '../../../shared/skills'
import { skillDraftIdentity, skillSlashQuery, type SkillInsertion } from '../store/skill-draft'
import '../assets/skills.css'

export type SkillPickerHandle = {
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
}
export type SkillMenuState = { listId?: string; activeId?: string }
const SkillPicker = forwardRef<
  SkillPickerHandle,
  {
    snapshot: AgentSnapshot
    draft: string
    disabled: boolean
    onInsert: (request: SkillInsertion) => void
    onMenuStateChange: (state: SkillMenuState) => void
  }
>(function SkillPicker({ snapshot, draft, disabled, onInsert, onMenuStateChange }, ref) {
  const listId = useId()
  const menu = useRef<HTMLDivElement>(null)
  const slash = skillSlashQuery(draft)
  const identity = skillDraftIdentity(snapshot)
  const identityKey = JSON.stringify(identity)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [loadedIdentity, setLoadedIdentity] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [active, setActive] = useState(0)
  const currentIdentity = useRef(identityKey)
  currentIdentity.current = identityKey
  const open = !disabled && Boolean(slash && identity) && dismissed !== draft
  useEffect(() => {
    if (!open || !identity) return
    let cancelled = false
    setSkills([])
    setLoadedIdentity('')
    setLoading(true)
    setError(false)
    void window.pi
      .send({ type: 'skills:list', sessionId: identity.sessionId, generation: identity.generation })
      .then(({ catalog }) => {
        if (!cancelled && currentIdentity.current === identityKey) {
          setSkills(catalog.skills.filter((skill) => skill.canInsert))
          setLoadedIdentity(identityKey)
        }
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, identityKey, retry])
  const filtered =
    loadedIdentity === identityKey
      ? skills.filter((skill) =>
          `${skill.name} ${skill.description}`
            .toLowerCase()
            .includes((slash?.query ?? '').toLowerCase())
        )
      : []
  useEffect(() => {
    setDismissed(null)
  }, [draft, identityKey])
  useEffect(() => {
    setActive(0)
  }, [slash?.query, identityKey])
  const choose = (skill: SkillSummary): void => {
    if (!identity || !slash || !open || loadedIdentity !== identityKey) return
    onInsert({ identity, skill, queryPrefix: slash.prefix })
    setDismissed(draft)
  }
  const activeId =
    open && !loading && filtered[active] ? `${listId}-${filtered[active].id}` : undefined
  useEffect(() => {
    onMenuStateChange({ listId: open && activeId ? listId : undefined, activeId })
    menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, activeId, listId, onMenuStateChange])
  useImperativeHandle(ref, () => ({
    handleKeyDown(event) {
      if (!open) return false
      if (event.nativeEvent.isComposing || event.keyCode === 229) return true
      if (event.key === 'Enter' && event.shiftKey) return false
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissed(draft)
        return true
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((value) =>
          filtered.length
            ? (value + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length
            : 0
        )
        return true
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const skill = filtered[Math.min(active, filtered.length - 1)]
        if (skill && !loading) choose(skill)
        return true
      }
      return false
    }
  }))
  if (!open) return null
  return (
    <div ref={menu} className="skill-slash-menu" aria-label="技能命令菜单">
      <div className="skill-slash-heading">
        技能 <span>↑ ↓ 选择 · Enter 插入 · Esc 关闭</span>
      </div>
      {loading ? (
        <p role="status">正在读取技能…</p>
      ) : error ? (
        <div role="alert">
          技能列表读取失败。
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            重试
          </button>
        </div>
      ) : !filtered.length ? (
        <p>没有匹配的已加载技能。</p>
      ) : (
        <div id={listId} role="listbox" aria-label="技能命令">
          {filtered.map((skill, index) => (
            <button
              type="button"
              role="option"
              id={`${listId}-${skill.id}`}
              aria-selected={index === active}
              key={skill.id}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(skill)}
            >
              <strong>/skill:{skill.name}</strong>
              <span>{skill.description}</span>
              <small>{skill.mode === 'manual-only' ? '仅手动调用' : '模型可发现'}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
})
export default SkillPicker
