import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, ImagePlus, Sparkles, Square, X } from 'lucide-react'
import type { PermissionMode, PromptImage, ThinkingLevel } from '../../../shared/contracts'
import { THINKING_LABEL } from '../store/model-presentation'
import type { MobileConversationSnapshot, MobileModelOption } from '../../../shared/mobile-gateway'
import { composeBlockChip, composerShouldSend } from '../../../shared/mobile-composer'
import { safeSkillName, type SkillSummary } from '../../../shared/skills'
import { ModelSheet, PermissionSheet, SkillSheet } from './ComposerSheets'
import { permissionTitle } from './permissions'
import { MAX_IMAGES, prepareImage, type DraftImage } from './images'
import { t } from '../../../shared/i18n'

type Draft = { text: string; images: DraftImage[] }
/** Unsent drafts survive switching sessions and snapshot updates, per session. */
const drafts = new Map<string, Draft>()
const EMPTY: Draft = { text: '', images: [] }

export function MobileComposer({
  snapshot,
  send,
  abort,
  clearQueue,
  setModel,
  setPermission,
  setThinking,
  loadSkills,
  notify
}: {
  snapshot: MobileConversationSnapshot
  send: (text: string, images: PromptImage[]) => Promise<void>
  abort: () => Promise<void>
  clearQueue: () => Promise<void>
  setModel: (option: MobileModelOption) => Promise<void>
  setPermission: (mode: PermissionMode) => Promise<void>
  setThinking: (level: ThinkingLevel) => Promise<void>
  loadSkills: () => Promise<SkillSummary[]>
  notify: (message: string) => void
}): React.JSX.Element {
  const key = snapshot.workerId
  const [draft, setDraftState] = useState<Draft>(() => drafts.get(key) ?? EMPTY)
  const [shownKey, setShownKey] = useState(key)
  const [sending, setSending] = useState(false)
  const [sheet, setSheet] = useState<'model' | 'permission' | 'skills' | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  if (shownKey !== key) {
    setShownKey(key)
    setDraftState(drafts.get(key) ?? EMPTY)
  }
  const setDraft = (next: Draft): void => {
    drafts.set(key, next)
    setDraftState(next)
  }
  useLayoutEffect(() => {
    const element = area.current
    if (!element) return
    element.style.height = '0px'
    element.style.height = `${Math.min(Math.max(element.scrollHeight, 44), 160)}px`
  }, [draft.text])

  const blocked = composeBlockChip(snapshot.composeBlockReason)
  const busy = snapshot.busy
  const queued = snapshot.queuedCount || 0
  const active = snapshot.models?.find(
    (option) => option.provider === snapshot.provider && option.id === snapshot.model
  )
  const imagesAllowed = active?.image ?? false
  const canSend = (Boolean(draft.text.trim()) || draft.images.length > 0) && !blocked && !sending
  const submit = (): void => {
    if (!canSend) return
    if (draft.images.length && !imagesAllowed) {
      notify(t('当前模型不支持图片，请换一个支持图片的模型'))
      return
    }
    const sent = draft
    setSending(true)
    void send(
      sent.text.trim(),
      sent.images.map(({ mimeType, data }) => ({ mimeType, data }))
    )
      .then(() => setDraft(EMPTY))
      .catch(() => {})
      .finally(() => setSending(false))
  }
  const addImages = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return
    const room = MAX_IMAGES - draft.images.length
    if (files.length > room) notify(t('一次最多 {MAX_IMAGES} 张图片', { MAX_IMAGES }))
    const added: DraftImage[] = []
    for (const file of [...files].slice(0, Math.max(0, room))) {
      try {
        added.push(await prepareImage(file))
      } catch (reason) {
        notify(reason instanceof Error ? reason.message : t('无法读取这张图片'))
      }
    }
    const current = drafts.get(key) ?? draft
    setDraft({ ...current, images: [...current.images, ...added].slice(0, MAX_IMAGES) })
  }
  const insertSkill = (skill: SkillSummary): void => {
    setSheet(null)
    if (!safeSkillName(skill.name)) return
    const rest = draft.text.replace(/^\/skill:[a-z0-9-]+\s*/, '')
    setDraft({ ...draft, text: `/skill:${skill.name} ${rest}` })
    requestAnimationFrame(() => {
      const element = area.current
      if (!element) return
      element.focus()
      element.setSelectionRange(element.value.length, element.value.length)
    })
  }
  const closeSheet = useCallback(() => setSheet(null), [])
  const skills = useCallback(() => loadSkills(), [loadSkills])

  return (
    <form
      className="m-composer"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {busy || queued || blocked ? (
        <div className="m-composer-status" role="status">
          {busy ? <span className="m-chip is-run">{t('运行中')}</span> : null}
          {queued ? <span className="m-chip is-run">{t('队列 {queued}', { queued })}</span> : null}
          {queued ? (
            <button type="button" className="m-chip-button" onClick={() => void clearQueue()}>
              {t('清空队列')}
            </button>
          ) : null}
          {blocked ? <span className="m-chip is-warn">{blocked}</span> : null}
        </div>
      ) : null}
      <p id="m-composer-keys" className="sr-only">
        {t('Enter 发送，Shift+Enter 换行。运行中发送会加入队列。')}
      </p>
      <div className="m-composer-box">
        {draft.images.length ? (
          <div className="m-attachments">
            {draft.images.map((image) => (
              <figure key={image.id} className="m-thumb">
                <img src={image.preview} alt={image.name || t('图片')} />
                <button
                  type="button"
                  aria-label={t('移除 {name}', { name: image.name || t('图片') })}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      images: draft.images.filter((item) => item.id !== image.id)
                    })
                  }
                >
                  <X size={12} />
                </button>
              </figure>
            ))}
          </div>
        ) : null}
        <textarea
          ref={area}
          rows={1}
          value={draft.text}
          enterKeyHint="send"
          autoComplete="off"
          placeholder={busy ? t('补充要求，完成后接着做') : t('提出后续要求')}
          aria-label={t('提出后续要求')}
          aria-describedby="m-composer-keys"
          onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          onKeyDown={(event) => {
            if (composerShouldSend(event.nativeEvent)) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className="m-composer-bar">
          <button
            type="button"
            className="m-tool-button"
            aria-label={t('添加图片')}
            disabled={draft.images.length >= MAX_IMAGES}
            onClick={() => picker.current?.click()}
          >
            <ImagePlus size={18} />
          </button>
          <input
            ref={picker}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              void addImages(event.target.files)
              event.target.value = ''
            }}
          />
          <button
            type="button"
            className="m-tool-button"
            aria-label={t('使用技能')}
            onClick={() => setSheet('skills')}
          >
            <Sparkles size={18} />
          </button>
          <div className="m-chips">
            <button
              type="button"
              className={`m-chip-button${snapshot.permissionMode === 'open' ? ' is-risky' : ''}`}
              aria-label={t('工具权限：{value}', {
                value: permissionTitle(snapshot.permissionMode)
              })}
              onClick={() => setSheet('permission')}
            >
              {permissionTitle(snapshot.permissionMode)}
              <ChevronDown size={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="m-chip-button is-model"
              aria-label={t('模型：{name}', {
                name: active?.name ?? snapshot.model ?? t('未选择')
              })}
              onClick={() => setSheet('model')}
            >
              <span>{active?.name ?? snapshot.model ?? t('选择模型')}</span>
              {snapshot.thinking && snapshot.thinking.level !== 'off' ? (
                <em className="m-chip-effort">{THINKING_LABEL[snapshot.thinking.level]}</em>
              ) : null}
              <ChevronDown size={12} aria-hidden="true" />
            </button>
          </div>
          {busy ? (
            <button
              type="button"
              className="m-stop"
              aria-label={t('停止')}
              onClick={() => void abort()}
            >
              <Square size={12} fill="currentColor" aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="submit"
            className={`m-send${busy ? ' is-queue' : ''}`}
            aria-label={busy ? t('加入队列') : t('发送')}
            disabled={!canSend}
          >
            {busy ? t('队列') : <ArrowUp size={18} aria-hidden="true" />}
          </button>
        </div>
      </div>
      {sheet === 'model' ? (
        <ModelSheet
          models={snapshot.models ?? []}
          providers={snapshot.providers}
          provider={snapshot.provider}
          model={snapshot.model}
          thinking={snapshot.thinking}
          onThinking={(level) => {
            if (level !== snapshot.thinking?.level) void setThinking(level).catch(() => {})
          }}
          onClose={closeSheet}
          onPick={(option) => {
            setSheet(null)
            if (option.provider !== snapshot.provider || option.id !== snapshot.model)
              void setModel(option).catch(() => {})
          }}
        />
      ) : null}
      {sheet === 'permission' ? (
        <PermissionSheet
          mode={snapshot.permissionMode}
          onClose={closeSheet}
          onPick={(mode) => {
            setSheet(null)
            if (mode !== snapshot.permissionMode) void setPermission(mode).catch(() => {})
          }}
        />
      ) : null}
      {sheet === 'skills' ? (
        <SkillSheet load={skills} onPick={insertSkill} onClose={closeSheet} />
      ) : null}
    </form>
  )
}
