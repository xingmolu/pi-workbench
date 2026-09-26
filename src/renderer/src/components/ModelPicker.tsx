import { useEffect, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Command } from 'cmdk'
import { Check, ChevronDown, Search, Settings2 } from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import { sessionHasTranscript } from '../store/composer-model-selection'
import { formatTokens } from '../store/conversation-presentation'

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
  const current = snapshot.models.find(
    (model) => model.provider === snapshot.activeProvider && model.id === snapshot.activeModel
  )
  const currentImageStatus = current
    ? current.input?.includes('image')
      ? '已配置图像输入'
      : '未声明图像输入能力'
    : '未选择模型'
  const account = snapshot.accounts.find((item) => item.id === snapshot.activeProvider)
  useEffect(() => {
    onOpenChange(false)
    setQuery('')
  }, [snapshot.sessionId, snapshot.generation, snapshot.project?.path])
  const accounts = snapshot.accounts.filter((item) => item.connected)
  const selected = [snapshot.activeProvider, snapshot.activeModel].join(':')
  const blocked = !snapshot.ready || !snapshot.project || snapshot.busy
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
        aria-label="选择模型"
        title={
          snapshot.busy
            ? '运行结束后可以切换模型'
            : `${account?.name ?? '账号'} · ${current?.name ?? '选择模型'} · ${currentImageStatus}`
        }
      >
        <span>{current?.name ?? '选择模型'}</span>
        <ChevronDown size={12} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="model-picker"
          aria-label="账号与模型"
          sideOffset={8}
          align="start"
          collisionPadding={12}
          data-native-suspend="true"
        >
          <Command label="搜索账号与模型" defaultValue={selected}>
            <label className="model-picker-search">
              <Search size={15} />
              <Command.Input
                autoFocus
                aria-label="搜索模型或账号"
                placeholder="搜索模型或账号…"
                value={query}
                onValueChange={setQuery}
              />
            </label>
            <Command.List className="model-picker-list">
              <Command.Empty>没有匹配的模型。请检查账号配置。</Command.Empty>
              {accounts.map((provider) => (
                <Command.Group key={provider.id} heading={provider.name}>
                  {snapshot.models
                    .filter((model) => model.provider === provider.id)
                    .map((model) => (
                      <Command.Item
                        key={model.id}
                        value={`${provider.id}:${model.id}`}
                        keywords={[provider.name, model.name, model.id]}
                        disabled={Boolean(model.unavailableReason)}
                        title={model.unavailableReason}
                        onSelect={() => {
                          onOpenChange(false)
                          onSelect(model.provider, model.id)
                        }}
                      >
                        <span>
                          <strong>{model.name}</strong>
                          <small>
                            {model.unavailableReason ??
                              `${formatTokens(model.contextWindow)} 上下文 · ${model.input?.includes('image') ? '已配置图像输入' : '未声明图像输入能力'}`}
                          </small>
                        </span>
                        {model.provider === snapshot.activeProvider &&
                          model.id === snapshot.activeModel && (
                            <Check size={15} aria-label="当前模型" />
                          )}
                      </Command.Item>
                    ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
          <p className="model-picker-note">
            {sessionHasTranscript(snapshot)
              ? '切换模型保留当前会话和历史。'
              : '账号与模型一起选择，不会创建额外会话。'}
            可用性以服务端响应为准。
          </p>
          <div className="model-picker-actions">
            <button
              type="button"
              onClick={() => {
                onOpenChange(false)
                onLogin()
              }}
            >
              登录 Codex
            </button>
            <button
              type="button"
              onClick={() => {
                onOpenChange(false)
                onSettings()
              }}
            >
              <Settings2 size={14} />
              管理账号与模型
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
