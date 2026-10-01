import { useState } from 'react'
import * as Dropdown from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Cpu, LoaderCircle } from 'lucide-react'
import { useRuntimeCatalog } from '../store/runtime-catalog'
import { engineSummary } from '../store/engine-presentation'
import { confirmDiscardSettingsDraft, useSettingsDraftController } from './SettingsDraftContext'
import { commandOrigin, usePiStore } from '../store/pi-store'

/**
 * Engine changes open a new chat; they never reinterpret a saved or running conversation.
 * `split` is the chevron half of the sidebar's New chat button; `field` is the settings control.
 */
export default function RuntimePicker({
  variant = 'field',
  onNewSession,
  disabled = false
}: {
  variant?: 'split' | 'field'
  /** Picking the engine already in use simply starts a new chat with it. */
  onNewSession?: () => void
  disabled?: boolean
}): React.JSX.Element {
  const draft = useSettingsDraftController()
  const snapshot = usePiStore((state) => state.snapshot)
  const runtimes = useRuntimeCatalog((state) => state.runtimes)
  const [pending, setPending] = useState(false)
  const current = snapshot.runtime
  const select = async (id: string): Promise<void> => {
    if (id === current?.id) {
      onNewSession?.()
      return
    }
    if (!confirmDiscardSettingsDraft(Boolean(draft?.dirty))) return
    draft?.clear()
    setPending(true)
    try {
      const next = await window.pi.selectRuntime(id, commandOrigin(usePiStore.getState().snapshot))
      usePiStore.getState().setSnapshot(next)
    } catch (error) {
      usePiStore.getState().setClientError(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <Dropdown.Root>
      <Dropdown.Trigger
        className={variant === 'split' ? 'runtime-picker-split' : 'runtime-picker-trigger'}
        aria-label="选择 Agent 引擎"
        title={variant === 'split' ? '选择新会话使用的引擎' : undefined}
        disabled={disabled || pending || !snapshot.ready || Boolean(snapshot.edit?.pending)}
      >
        {variant === 'split' ? (
          pending ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <ChevronDown size={14} />
          )
        ) : (
          <>
            {pending ? <LoaderCircle size={14} className="spin" /> : <Cpu size={14} />}
            <span>{current?.label ?? 'Agent 引擎'}</span>
            <ChevronDown size={12} />
          </>
        )}
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          className="runtime-picker-menu"
          align={variant === 'split' ? 'end' : 'start'}
          sideOffset={6}
        >
          <Dropdown.Label className="runtime-picker-label">新会话使用的引擎</Dropdown.Label>
          {runtimes.map((runtime) => (
            <Dropdown.Item
              className="runtime-picker-option"
              key={runtime.id}
              onSelect={() => void select(runtime.id)}
            >
              <span>
                <strong>{runtime.label}</strong>
                <small>{engineSummary(runtime)}</small>
              </span>
              {current?.id === runtime.id ? <Check size={14} /> : null}
            </Dropdown.Item>
          ))}
          <p className="runtime-picker-note">切换后新建会话，当前任务可在后台继续。</p>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  )
}
