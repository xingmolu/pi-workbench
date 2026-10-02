import { useNavigationLibrary } from '../store/navigation-library'
import { useEffect, useRef, useState, type RefObject } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Command } from 'cmdk'
import {
  ArrowLeft,
  FileSearch,
  FolderOpen,
  MessageSquare,
  MessageSquarePlus,
  Search,
  X,
  Puzzle
} from 'lucide-react'
import type { AgentSnapshot } from '../../../shared/contracts'
import type { PluginCommandSummary } from '../../../shared/workbench-contracts'
import type { ProjectSearchResult, SessionSearchResult } from '../../../shared/session-search'
import { projectNavigationReason } from '../../../shared/project-catalog'
import { sessionStatusDisplay } from '../../../shared/session-presentation'
import { PaletteRequestEpoch } from '../store/overlay-state'
import { usePiStore } from '../store/pi-store'
import { t } from '../../../shared/i18n'
import '../assets/command-palette.css'

type Props = {
  snapshot: AgentSnapshot
  returnFocusRef: RefObject<HTMLElement | null>
  nativeFocusToken?: string
  disabledReason: string | null
  filesAvailable: boolean
  onClose: () => void
  onNavigate: (cwd: string, path?: string) => Promise<void>
  onChooseProject: () => Promise<void>
  onSearchFiles: () => void
  pluginCommands?: readonly PluginCommandSummary[]
  onRunPluginCommand?: (command: PluginCommandSummary) => void
}
const identityOf = (snapshot: AgentSnapshot): string =>
  JSON.stringify([snapshot.sessionId, snapshot.generation, snapshot.project?.path, snapshot.ready])
const sessionValue = (item: SessionSearchResult['items'][number]): string =>
  JSON.stringify(['session', item.cwd, item.sessionPath, item.id])

/** Mounted for one opening only, so closing also discards query/results and pending selection. */
export default function GlobalCommandPalette({
  snapshot,
  returnFocusRef,
  nativeFocusToken,
  disabledReason,
  filesAvailable,
  onClose,
  onNavigate,
  onChooseProject,
  onSearchFiles,
  pluginCommands = [],
  onRunPluginCommand
}: Props): React.JSX.Element {
  const [includeRemoved, setIncludeRemoved] = useState(false)
  const libraryRevision = useNavigationLibrary((state) => state.library.revision)
  const [mode, setMode] = useState<'sessions' | 'projects'>('sessions')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const selectionTouched = useRef(false)
  const enabledActions = useRef(new Set<string>())
  const [result, setResult] = useState<{
    key: string
    sessions?: SessionSearchResult
    projects?: ProjectSearchResult
    request: ReturnType<PaletteRequestEpoch['begin']>
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  const restoreOpener = useRef(true)
  const restoreNative = useRef(true)
  const epoch = useRef(new PaletteRequestEpoch())
  const identity = identityOf(snapshot)
  const source = useRef(identity)
  source.current = identity
  const key = JSON.stringify([mode, query, identity, retry, includeRemoved, libraryRevision])
  const current = result?.key === key ? result : null
  const navigationReason = disabledReason ?? projectNavigationReason(snapshot)
  const initialIdentity = useRef(identity)
  useEffect(() => {
    if (identity !== initialIdentity.current) {
      restoreNative.current = false
      epoch.current.invalidate()
      onClose()
    }
  }, [identity, onClose])
  useEffect(() => {
    const request = epoch.current.begin(identity)
    setResult(null)
    setError(null)
    const timer = setTimeout(
      () => {
        const command =
          mode === 'sessions'
            ? ({
                type: 'session:search',
                query,
                limit: 50,
                includeHidden: includeRemoved,
                includeArchived: includeRemoved
              } as const)
            : ({
                type: 'project:search',
                query,
                limit: 50,
                includeHidden: includeRemoved,
                includeArchived: includeRemoved
              } as const)
        void window.pi
          .send(command)
          .then((response) => {
            if (!epoch.current.current(request, source.current)) return
            if (response.kind === 'session-search') {
              setResult({ key, request, sessions: response.result })
              setSelected((previous) =>
                selectionTouched.current &&
                (enabledActions.current.has(previous) ||
                  response.result.items.some((item) => sessionValue(item) === previous))
                  ? previous
                  : response.result.items[0]
                    ? sessionValue(response.result.items[0])
                    : ''
              )
            } else if (response.kind === 'project-search') {
              setResult({ key, request, projects: response.result })
              setSelected((previous) =>
                selectionTouched.current &&
                response.result.items.some((item) => item.available && item.cwd === previous)
                  ? previous
                  : (response.result.items.find((item) => item.available)?.cwd ?? '')
              )
            }
          })
          .catch(() => {
            if (epoch.current.current(request, source.current))
              setError(t('目录暂时不可读取，请重试。'))
          })
      },
      query ? 120 : 0
    )
    return () => {
      clearTimeout(timer)
      epoch.current.invalidate()
    }
  }, [key, identity, mode, query, retry])
  const changeQuery = (value: string): void => {
    epoch.current.invalidate()
    selectionTouched.current = false
    setSelected('')
    setResult(null)
    setError(null)
    setQuery(value)
  }
  const close = (): void => {
    epoch.current.invalidate()
    onClose()
  }
  const validSource = (): boolean => identityOf(usePiStore.getState().snapshot) === source.current
  const navigate = (cwd: string, path?: string): void => {
    if (
      !current ||
      navigationReason ||
      !validSource() ||
      !epoch.current.current(current.request, source.current)
    )
      return
    // No deferred close: a later response must never close a newly opened palette.
    restoreNative.current = false
    close()
    void onNavigate(cwd, path)
  }
  const quick = (action: 'new' | 'folder' | 'files'): void => {
    if (!validSource() || (action !== 'files' && navigationReason)) return
    if (action === 'new') {
      epoch.current.invalidate()
      selectionTouched.current = false
      setResult(null)
      setSelected('')
      setQuery('')
      setMode('projects')
      input.current?.focus()
    } else {
      if (action === 'files' && !filesAvailable) return
      restoreNative.current = false
      if (action === 'files') restoreOpener.current = false
      close()
      if (action === 'folder') void onChooseProject()
      else onSearchFiles()
    }
  }
  const summary = current?.sessions ?? current?.projects
  const term = query.trim().toLocaleLowerCase()
  const actions = [
    {
      id: 'new',
      label: t('新建会话'),
      detail: t('选择已有项目'),
      icon: MessageSquarePlus,
      reason: navigationReason
    },
    {
      id: 'folder',
      label: t('打开文件夹'),
      detail: t('选择项目目录'),
      icon: FolderOpen,
      reason: navigationReason
    },
    {
      id: 'files',
      label: t('搜索文件'),
      detail: t('在当前项目中按文件名搜索'),
      icon: FileSearch,
      reason: filesAvailable ? null : t('请先选择可用工作区')
    }
  ] as const
  const matchingActions = actions.filter(
    (action) => !term || `${action.label} ${action.detail}`.includes(term)
  )
  const matchingPluginCommands = pluginCommands.filter(
    (command) =>
      !term ||
      [command.title, command.pluginName, ...command.keywords].some((text) =>
        text.toLocaleLowerCase().includes(term)
      )
  )
  const pluginValue = (command: PluginCommandSummary): string =>
    `plugin:${JSON.stringify([command.pluginId, command.commandId])}`
  enabledActions.current = new Set(
    mode === 'sessions'
      ? [
          ...matchingActions
            .filter((action) => !action.reason)
            .map((action) => `action:${action.id}`),
          ...matchingPluginCommands.map(pluginValue)
        ]
      : []
  )
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="command-overlay" />
        <Dialog.Content
          className="command-dialog"
          aria-describedby="command-description"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            input.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (nativeFocusToken) {
              void window.pi
                .nativePaletteFocus({
                  type: 'finish',
                  token: nativeFocusToken,
                  restore: restoreNative.current
                })
                .catch(() => {})
              return
            }
            if (restoreOpener.current && returnFocusRef.current?.isConnected)
              returnFocusRef.current.focus()
          }}
          onEscapeKeyDown={(event) => {
            if (composing.current || event.isComposing || event.keyCode === 229)
              event.preventDefault()
          }}
        >
          <Dialog.Title className="command-sr-only">{t('搜索与快捷操作')}</Dialog.Title>
          <Dialog.Description id="command-description" className="command-sr-only">
            {t('搜索所有项目中的会话标题。上下键选择，回车打开，Escape 关闭。')}
          </Dialog.Description>
          <Command
            shouldFilter={false}
            loop
            value={selected}
            onValueChange={setSelected}
            onKeyDownCapture={(event) => {
              if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
                event.stopPropagation()
                return
              }
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
                selectionTouched.current = true
            }}
            onPointerMoveCapture={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest('[cmdk-item]:not([aria-disabled="true"])')
              )
                selectionTouched.current = true
            }}
          >
            <div className="command-input-row">
              {mode === 'projects' ? (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t('返回会话搜索')}
                  onClick={() => {
                    changeQuery('')
                    setMode('sessions')
                  }}
                >
                  <ArrowLeft size={17} />
                </button>
              ) : (
                <Search size={18} aria-hidden="true" />
              )}
              <Command.Input
                ref={input}
                value={query}
                onValueChange={changeQuery}
                maxLength={200}
                aria-label={mode === 'sessions' ? t('搜索所有会话标题') : t('搜索已有项目')}
                placeholder={
                  mode === 'sessions'
                    ? t('搜索所有会话，或选择快捷操作…')
                    : t('选择新会话所在的项目…')
                }
                onCompositionStart={() => {
                  composing.current = true
                }}
                onCompositionEnd={() => {
                  composing.current = false
                }}
              />
              <Dialog.Close className="icon-btn" aria-label={t('关闭搜索')}>
                <X size={16} />
              </Dialog.Close>
            </div>
            <Command.List aria-label={mode === 'sessions' ? t('会话与操作') : t('已有项目')}>
              {navigationReason && (
                <p className="command-notice" role="status">
                  {t('{navigationReason}；仍可搜索与查看结果。', { navigationReason })}
                </p>
              )}
              {mode === 'sessions' && (
                <Command.Group heading={query ? t('匹配的会话') : t('最近会话')}>
                  {current?.sessions?.items.map((item) => {
                    const active =
                      item.cwd === snapshot.project?.path &&
                      item.sessionPath === snapshot.activeSessionPath &&
                      item.id === snapshot.sessionId
                    const status = active ? sessionStatusDisplay(snapshot.status).label : null
                    return (
                      <Command.Item
                        key={sessionValue(item)}
                        value={sessionValue(item)}
                        disabled={Boolean(navigationReason)}
                        onSelect={() => navigate(item.cwd, item.sessionPath)}
                        title={navigationReason ?? `${item.title}\n${item.cwd}`}
                      >
                        <MessageSquare size={15} aria-hidden="true" />
                        <span className="command-item-copy">
                          <span>{item.title}</span>
                          <small>
                            {item.projectName}
                            {item.runtimeId === 'claude'
                              ? ' · Claude Code'
                              : item.runtimeId === 'pi'
                                ? ' · Pi'
                                : ''}{' '}
                            · {item.cwd}
                          </small>
                        </span>
                        {status && <span className="command-item-status">{status}</span>}
                      </Command.Item>
                    )
                  })}
                </Command.Group>
              )}
              {mode === 'projects' && (
                <Command.Group heading={t('在项目中新建会话')}>
                  {current?.projects?.items.map((item) => (
                    <Command.Item
                      key={item.cwd}
                      value={item.cwd}
                      disabled={Boolean(navigationReason) || !item.available}
                      onSelect={() => navigate(item.cwd)}
                      title={item.cwd}
                    >
                      <FolderOpen size={15} aria-hidden="true" />
                      <span className="command-item-copy">
                        <span>{item.projectName}</span>
                        <small>{item.cwd}</small>
                      </span>
                      {!item.available && (
                        <span className="command-item-status">{t('目录不可用')}</span>
                      )}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              <div className="command-result-status" role="status">
                {error ? (
                  <span className="command-error">
                    {error}{' '}
                    <button type="button" onClick={() => setRetry((value) => value + 1)}>
                      {t('重试')}
                    </button>
                  </span>
                ) : !current ? (
                  t('正在搜索…')
                ) : summary?.total === 0 ? (
                  mode === 'sessions' ? (
                    t('没有匹配的会话标题')
                  ) : (
                    t('没有匹配的已有项目')
                  )
                ) : summary?.truncated ? (
                  t('显示 {shown} / {atLeast}{total} 个结果，请继续输入缩小范围。', {
                    shown: summary.items.length,
                    atLeast: summary.totalIsLowerBound ? t('至少 ') : '',
                    total: summary.total
                  })
                ) : mode === 'sessions' ? (
                  t('{total} 个会话', { total: summary?.total })
                ) : (
                  t('{total} 个项目', { total: summary?.total })
                )}
                {summary && (summary.skippedDirectories > 0 || summary.skippedEntries > 0) && (
                  <span>
                    {t(
                      '已跳过 {skippedDirectories} 个不可读取或含文件链接的目录、 {skippedEntries} 个无效条目。',
                      {
                        skippedDirectories: summary.skippedDirectories,
                        skippedEntries: summary.skippedEntries
                      }
                    )}
                  </span>
                )}
              </div>
              {mode === 'sessions' && matchingActions.length > 0 && (
                <Command.Group heading={t('快捷操作')}>
                  {matchingActions.map((action) => (
                    <Command.Item
                      key={action.id}
                      value={`action:${action.id}`}
                      disabled={Boolean(action.reason)}
                      onSelect={() => quick(action.id)}
                      title={action.reason ?? action.detail}
                    >
                      <action.icon size={15} aria-hidden="true" />
                      <span className="command-item-copy">
                        <span>{action.label}</span>
                        <small>{action.reason ?? action.detail}</small>
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {mode === 'sessions' && onRunPluginCommand && matchingPluginCommands.length > 0 && (
                <Command.Group heading={t('插件命令')}>
                  {matchingPluginCommands.map((command) => (
                    <Command.Item
                      key={pluginValue(command)}
                      value={pluginValue(command)}
                      onSelect={() => {
                        restoreNative.current = false
                        close()
                        onRunPluginCommand(command)
                      }}
                      title={command.pluginName}
                    >
                      <Puzzle size={15} aria-hidden="true" />
                      <span className="command-item-copy">
                        <span>{command.title}</span>
                        <small>{command.pluginName}</small>
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
            <footer className="command-footer">
              <span>{t('↑ ↓ 选择')}</span>
              <span>{t('↵ 打开')}</span>
              <span>{t('Esc 关闭')}</span>
              <span className="command-scope">
                {mode === 'sessions' ? t('所有项目 · 仅搜索标题') : t('已有项目与最近目录')}
              </span>
              <label className="command-include-removed">
                <input
                  type="checkbox"
                  checked={includeRemoved}
                  onChange={(event) => {
                    epoch.current.invalidate()
                    setIncludeRemoved(event.target.checked)
                  }}
                />
                {t('包含已移除项目与归档会话')}
              </label>
            </footer>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
