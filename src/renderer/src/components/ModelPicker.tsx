import { useEffect, useMemo, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Command } from 'cmdk'
import { ArrowLeft, Check, ChevronDown, ChevronRight, Lock, Search, Settings2 } from 'lucide-react'
import type {
  AccountSummary,
  AgentSnapshot,
  ModelSummary,
  ThinkingLevel
} from '../../../shared/contracts'
import {
  THINKING_LABEL,
  contextLabel,
  groupModelsByFamily,
  modelFamily,
  recentModels,
  rememberModel
} from '../store/model-presentation'
import { t } from '../../../shared/i18n'

const keyOf = (model: Pick<ModelSummary, 'provider' | 'id'>): string =>
  `${model.provider}:${model.id}`
const accountLabel = (account: AccountSummary): string => account.email ?? account.name
/** Every typed word must appear in the model's ID, name or account; fuzzy matching floods long lists. */
const matchModel = (value: string, search: string, keywords?: string[]): number => {
  const text = [value, ...(keywords ?? [])].join(' ').toLowerCase()
  return search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word))
    ? 1
    : 0
}

function ModelRow({
  model,
  current,
  group,
  onChoose
}: {
  model: ModelSummary
  current: boolean
  group: string
  onChoose: (model: ModelSummary) => void
}): React.JSX.Element {
  const unavailable = Boolean(model.unavailableReason)
  return (
    <Command.Item
      value={`${group}:${keyOf(model)}`}
      keywords={[model.provider, model.name, model.id]}
      disabled={unavailable}
      className={current ? 'is-current' : undefined}
      onSelect={() => onChoose(model)}
    >
      <span className="model-row-text">
        <strong>{model.name || model.id}</strong>
        <small>
          {model.unavailableReason ?? (model.name && model.name !== model.id ? model.id : '')}
        </small>
      </span>
      <span className="model-row-meta">
        {unavailable ? (
          <Lock size={13} aria-label={t('不可用')} />
        ) : (
          <>
            {model.reasoning ? (
              <span className="model-tag" title={t('支持推理，可调整思考强度')}>
                {t('推理')}
              </span>
            ) : null}
            {model.input?.includes('image') ? (
              <span className="model-tag" title={t('支持图片输入')}>
                {t('图片')}
              </span>
            ) : null}
            {model.contextWindow ? (
              <span
                className="model-context"
                title={t('上下文 {toLocaleString} tokens', {
                  toLocaleString: model.contextWindow.toLocaleString()
                })}
              >
                {contextLabel(model.contextWindow)}
              </span>
            ) : null}
          </>
        )}
        <span className="model-check" aria-hidden={!current}>
          {current ? <Check size={14} aria-label={t('当前模型')} /> : null}
        </span>
      </span>
    </Command.Item>
  )
}

/** Choosing one row commits provider + model atomically; browsing never changes the session. */
export default function ModelPicker({
  snapshot,
  open,
  onOpenChange,
  onSelect,
  onLogin,
  onSettings
}: {
  snapshot: AgentSnapshot
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (provider: string, model: string) => void
  onLogin: () => void
  onSettings: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  // The account being browsed; null shows the account list. Browsing never changes the session.
  const [scope, setScope] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [thinkingError, setThinkingError] = useState('')
  const [recents, setRecents] = useState<string[]>(recentModels)
  const current = snapshot.models.find(
    (model) => model.provider === snapshot.activeProvider && model.id === snapshot.activeModel
  )
  const account = snapshot.accounts.find((item) => item.id === snapshot.activeProvider)
  useEffect(() => {
    onOpenChange(false)
    setQuery('')
  }, [snapshot.sessionId, snapshot.generation, snapshot.project?.path])
  useEffect(() => {
    if (open) {
      setRecents(recentModels())
      setThinkingError('')
      enter(null)
    }
  }, [open])
  const accounts = snapshot.accounts.filter(
    (item) => item.connected && snapshot.models.some((model) => model.provider === item.id)
  )
  // With one account there is nothing to choose between, so the picker opens inside it.
  const only = accounts.length === 1 ? accounts[0].id : null
  const browsing = accounts.find((item) => item.id === (scope ?? only))
  const scoped = browsing ? snapshot.models.filter((model) => model.provider === browsing.id) : []
  const families = groupModelsByFamily(scoped)
  const enter = (id: string | null): void => {
    setQuery('')
    setScope(id)
    const target = id ?? only
    const inAccount = current && current.provider === target
    const models = snapshot.models.filter((model) => model.provider === target)
    const first = groupModelsByFamily(models)[0]?.id
    setExpanded(new Set([inAccount ? modelFamily(current).id : (first ?? '')]))
  }
  const codex = snapshot.accounts.find((item) => item.id === 'openai-codex')
  // Opening highlights the current model where it first appears, so recents stay in view.
  const selectedKey = browsing
    ? current?.provider === browsing.id
      ? `all:${keyOf(current)}`
      : undefined
    : current
      ? recentModels().includes(keyOf(current))
        ? `recent:${keyOf(current)}`
        : `account:${current.provider}`
      : undefined
  const blocked = !snapshot.ready || !snapshot.project || snapshot.busy
  const recent = useMemo(
    () =>
      recents
        .map((key) => snapshot.models.find((model) => keyOf(model) === key))
        .filter((model): model is ModelSummary => Boolean(model && !model.unavailableReason))
        .slice(0, 3),
    [recents, snapshot.models]
  )
  const thinking = snapshot.thinking
  const choose = (model: ModelSummary): void => {
    onOpenChange(false)
    rememberModel(model.provider, model.id)
    if (model.provider !== snapshot.activeProvider || model.id !== snapshot.activeModel)
      onSelect(model.provider, model.id)
  }
  const setThinking = (level: ThinkingLevel): void => {
    setThinkingError('')
    void window.pi
      .send({ type: 'thinking:set', level })
      .catch((error: unknown) =>
        setThinkingError(error instanceof Error ? error.message : String(error))
      )
  }
  return (
    <Popover.Root
      open={open && !blocked}
      onOpenChange={(next) => {
        setQuery('')
        onOpenChange(next)
      }}
    >
      <Popover.Trigger
        className="tool-chip model-chip"
        disabled={blocked}
        aria-label={t('选择模型')}
        title={
          snapshot.busy
            ? t('运行结束后可以切换模型')
            : [
                account?.email ?? account?.name,
                current?.name || current?.id || snapshot.activeModel,
                thinking ? t('思考 {value}', { value: THINKING_LABEL[thinking.level] }) : ''
              ]
                .filter(Boolean)
                .join(' · ') || t('选择模型')
        }
      >
        <span>{current?.name || current?.id || snapshot.activeModel || t('选择模型')}</span>
        {thinking && thinking.level !== 'off' ? (
          <span className="model-chip-effort">{THINKING_LABEL[thinking.level]}</span>
        ) : null}
        <ChevronDown size={12} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="model-picker"
          aria-label={t('账号与模型')}
          side="top"
          sideOffset={8}
          align="start"
          collisionPadding={12}
          data-native-suspend="true"
          onEscapeKeyDown={(event) => {
            // Escape steps back to the account list before it closes the picker.
            if (scope && !only) {
              event.preventDefault()
              enter(null)
            }
          }}
        >
          <Command
            key={browsing?.id ?? 'accounts'}
            label={t('搜索账号与模型')}
            defaultValue={selectedKey}
            filter={matchModel}
            loop
          >
            {browsing ? (
              <div className="model-picker-scope">
                {only ? null : (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={t('返回账号列表')}
                    onClick={() => enter(null)}
                  >
                    <ArrowLeft size={14} />
                  </button>
                )}
                <strong>{accountLabel(browsing)}</strong>
                {browsing.plan || browsing.subscription ? (
                  <em>{browsing.plan ?? t('订阅')}</em>
                ) : null}
                <small>{scoped.length}</small>
              </div>
            ) : null}
            <label className="model-picker-search">
              <Search size={14} />
              <Command.Input
                autoFocus
                aria-label={browsing && !only ? t('搜索此账号的模型') : t('搜索模型或账号')}
                placeholder={
                  browsing && !only
                    ? t('搜索 {label} 的模型', { label: accountLabel(browsing) })
                    : t('搜索模型或账号')
                }
                value={query}
                onValueChange={setQuery}
                onKeyDown={(event) => {
                  if (event.key === 'Backspace' && !query && scope && !only) {
                    event.preventDefault()
                    enter(null)
                  }
                }}
              />
              <kbd>esc</kbd>
            </label>
            <Command.List className="model-picker-list">
              <Command.Empty>
                {t('没有匹配的模型。')}
                <button type="button" onClick={() => setQuery('')}>
                  {t('清除搜索')}
                </button>
              </Command.Empty>
              {browsing ? (
                families.map((family) => {
                  const showAll = Boolean(query) || !family.label
                  const open = showAll || expanded.has(family.id)
                  const rows = open
                    ? family.models.map((model) => (
                        <ModelRow
                          key={keyOf(model)}
                          model={model}
                          group="all"
                          current={model === current}
                          onChoose={choose}
                        />
                      ))
                    : null
                  if (!family.label) return rows
                  return (
                    <Command.Group
                      key={family.id}
                      heading={
                        query ? (
                          <span className="model-group-heading">
                            <span>{family.label}</span>
                          </span>
                        ) : undefined
                      }
                    >
                      {!query ? (
                        <Command.Item
                          value={`family:${family.id}`}
                          className="model-family"
                          aria-expanded={open}
                          onSelect={() =>
                            setExpanded((current) => {
                              const next = new Set(current)
                              if (next.has(family.id)) next.delete(family.id)
                              else next.add(family.id)
                              return next
                            })
                          }
                        >
                          <ChevronRight size={13} className="model-family-chevron" />
                          <span>{family.label}</span>
                          <small>{family.models.length}</small>
                        </Command.Item>
                      ) : null}
                      {rows}
                    </Command.Group>
                  )
                })
              ) : query ? (
                // Searching from the account list looks through every account's models.
                accounts.map((provider) => (
                  <Command.Group
                    key={provider.id}
                    heading={
                      <span className="model-group-heading">
                        <span>{accountLabel(provider)}</span>
                      </span>
                    }
                  >
                    {snapshot.models
                      .filter((model) => model.provider === provider.id)
                      .map((model) => (
                        <ModelRow
                          key={keyOf(model)}
                          model={model}
                          group="all"
                          current={model === current}
                          onChoose={choose}
                        />
                      ))}
                  </Command.Group>
                ))
              ) : (
                <>
                  {recent.length > 1 ? (
                    <Command.Group heading={t('最近使用')}>
                      {recent.map((model) => (
                        <ModelRow
                          key={`recent:${keyOf(model)}`}
                          model={model}
                          group="recent"
                          current={model === current}
                          onChoose={choose}
                        />
                      ))}
                    </Command.Group>
                  ) : null}
                  <Command.Group heading={t('账号')}>
                    {accounts.map((provider) => {
                      const count = snapshot.models.filter(
                        (model) => model.provider === provider.id
                      ).length
                      const active = current?.provider === provider.id
                      return (
                        <Command.Item
                          key={provider.id}
                          value={`account:${provider.id}`}
                          className={active ? 'model-account is-current' : 'model-account'}
                          onSelect={() => enter(provider.id)}
                        >
                          <span className="model-row-text">
                            <strong>
                              {accountLabel(provider)}
                              {provider.plan || provider.subscription ? (
                                <em className="model-account-plan">{provider.plan ?? t('订阅')}</em>
                              ) : null}
                            </strong>
                            <small>{active ? current?.name || current?.id : ''}</small>
                          </span>
                          <span className="model-row-meta">
                            <span className="model-context">{count}</span>
                            <ChevronRight size={14} aria-hidden="true" />
                          </span>
                        </Command.Item>
                      )
                    })}
                  </Command.Group>
                </>
              )}
            </Command.List>
          </Command>
          {thinking && thinking.available.length > 1 ? (
            <div className="model-thinking">
              <span className="model-thinking-label">{t('思考强度')}</span>
              <div className="model-thinking-levels" role="radiogroup" aria-label={t('思考强度')}>
                {thinking.available.map((level) => (
                  <button
                    type="button"
                    role="radio"
                    key={level}
                    aria-checked={thinking.level === level}
                    onClick={() => setThinking(level)}
                  >
                    {THINKING_LABEL[level]}
                  </button>
                ))}
              </div>
              {thinkingError ? (
                <p className="model-thinking-error" role="alert">
                  {thinkingError}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="model-picker-actions">
            <button
              type="button"
              onClick={() => {
                onOpenChange(false)
                onSettings()
              }}
            >
              <Settings2 size={13} />

              {t('管理账号与模型')}
            </button>
            {codex && !codex.connected ? (
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false)
                  onLogin()
                }}
              >
                {t('登录 Codex')}
              </button>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
