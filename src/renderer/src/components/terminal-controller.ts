import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { TERMINAL_THEMES } from './terminal-theme'
import type { TerminalIdentity, TerminalMetadata, TerminalEvent } from '../../../shared/terminal'

export const terminalIdentity = (t: TerminalIdentity): TerminalIdentity => ({
  projectPath: t.projectPath,
  terminalId: t.terminalId,
  generation: t.generation,
  connectionEpoch: t.connectionEpoch
})
export const terminalKey = (t: TerminalIdentity): string =>
  `${t.projectPath}:${t.terminalId}:${t.generation}:${t.connectionEpoch}`
export function pasteSafety(text: string): 'empty' | 'oversized' | 'confirm' | 'safe' {
  if (!text) return 'empty'
  if (new TextEncoder().encode(text).length > 8192) return 'oversized'
  return /[\x00-\x1f\x7f-\x9f]/u.test(text) ? 'confirm' : 'safe'
}
export function displayTitle(text: string): string {
  return [...text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '')]
    .slice(0, 64)
    .join('')
}
export function pastePreview(text: string): string {
  return text.replace(
    /[\x00-\x09\x0b-\x1f\x7f-\x9f]/gu,
    (c) => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`
  )
}
export type TerminalEntry = {
  metadata: TerminalMetadata
  title: string
  ordinal: number
  pendingDismiss?: boolean
}
type Instance = {
  terminal: Terminal
  fit: FitAddon
  element: HTMLDivElement
  cancelComposition: () => void
  dispose: () => void
}
export type TerminalPrompt = {
  kind: 'paste' | 'close' | 'recreate'
  identity: TerminalIdentity
  text?: string
}

/** Owns the lifetime of the emulator DOM, independent of React visibility and project selection. */
export class TerminalController {
  private theme: 'dark' | 'light' = 'dark'
  setTheme(theme: 'dark' | 'light'): void {
    this.theme = theme
    for (const instance of this.instances.values()) instance.terminal.options.theme = TERMINAL_THEMES[theme]
  }
  entries: TerminalEntry[] = []
  prompt: TerminalPrompt | null = null
  private errorValue = ''
  private closeErrorOwner: string | null = null
  get error(): string {
    return this.errorValue
  }
  set error(message: string) {
    this.errorValue = message
    this.closeErrorOwner = null
  }
  private closeError(entry: TerminalEntry, message: string): void {
    this.error = message
    this.closeErrorOwner = terminalKey(entry.metadata)
  }
  busy = false
  interactionRevision = 0
  private project: string | null = null
  private visible = false
  private selection = new Map<string, string>()
  private instances = new Map<string, Instance>()
  private unsubscribe: () => void
  private disposed = false
  private ordinal = 0
  private listRevision = 0
  private frame = 0
  private earlyStates = new Map<string, TerminalMetadata>()
  constructor(
    private stage: HTMLDivElement,
    private changed: () => void
  ) {
    this.unsubscribe = window.pi.onTerminalEvent((event) => this.event(event))
  }
  get current(): TerminalEntry | undefined {
    return this.entries.find(
      (e) =>
        e.metadata.projectPath === this.project &&
        terminalKey(e.metadata) === this.selection.get(this.project!)
    )
  }
  get currentHasScreen(): boolean {
    return !!this.current && this.instances.has(terminalKey(this.current.metadata))
  }
  get retainedCount(): number {
    return (
      this.instances.size +
      this.entries.filter(
        (entry) => entry.pendingDismiss && !this.instances.has(terminalKey(entry.metadata))
      ).length
    )
  }
  private notify(): void {
    if (!this.disposed) this.changed()
  }
  private active(identity: TerminalIdentity): boolean {
    return (
      this.visible && !!this.current && terminalKey(this.current.metadata) === terminalKey(identity)
    )
  }
  private interactive(metadata: TerminalMetadata): boolean {
    return (
      metadata.connection === 'consumer' &&
      !metadata.exitConfirmed &&
      !metadata.failure &&
      ['starting', 'running'].includes(metadata.state)
    )
  }
  async context(project: string | null, visible: boolean): Promise<void> {
    const switched = this.project !== project
    if (switched || this.visible !== visible) {
      this.cancelComposition()
      this.prompt = null
      this.interactionRevision++
    }
    this.project = project
    this.visible = visible
    this.syncVisibility()
    this.notify()
    if (!project || !switched) return
    const revision = ++this.listRevision
    try {
      const result = await window.pi.terminal({ type: 'list', projectPath: project })
      if (this.disposed || revision !== this.listRevision || this.project !== project) return
      if (result.type === 'list') {
        for (const pending of this.entries.filter(
          (entry) => entry.metadata.projectPath === project && entry.pendingDismiss
        )) {
          if (
            !result.terminals.some(
              (metadata) => terminalKey(metadata) === terminalKey(pending.metadata)
            )
          )
            this.removeEntry(pending)
        }
        for (const metadata of result.terminals) {
          const existing = this.entries.find(
            (e) => terminalKey(e.metadata) === terminalKey(metadata)
          )
          if (existing?.pendingDismiss && metadata.exitConfirmed) {
            const dismissed = await window.pi.terminal({
              type: 'close',
              ...terminalIdentity(metadata)
            })
            if (dismissed.type === 'ok') this.removeEntry(existing)
            continue
          }
          const entry = existing ?? this.upsert(metadata)
          if (
            entry.metadata.connection === 'unattached' &&
            this.instances.has(terminalKey(entry.metadata))
          )
            await this.attach(entry)
        }
        if (!this.selection.has(project)) {
          const first = this.entries.find((e) => e.metadata.projectPath === project)
          if (first) this.selection.set(project, terminalKey(first.metadata))
        }
      } else if (result.type === 'unavailable' && this.project === project)
        this.error = result.message
      this.syncVisibility()
      this.notify()
    } catch {
      this.error = '终端连接失败，请重试。'
      this.notify()
    }
  }
  select(entry: TerminalEntry): void {
    if (entry.metadata.projectPath !== this.project) return
    this.cancelComposition()
    this.prompt = null
    this.interactionRevision++
    this.selection.set(this.project!, terminalKey(entry.metadata))
    this.syncVisibility()
    this.notify()
    this.focus()
  }
  private upsert(metadata: TerminalMetadata): TerminalEntry {
    let entry = this.entries.find((e) => terminalKey(e.metadata) === terminalKey(metadata))
    if (entry) entry.metadata = metadata
    else {
      for (const old of this.entries.filter((e) => e.metadata.terminalId === metadata.terminalId))
        this.disposeInstance(terminalKey(old.metadata))
      this.entries = this.entries.filter((e) => e.metadata.terminalId !== metadata.terminalId)
      entry = { metadata, title: '', ordinal: ++this.ordinal }
      this.entries.push(entry)
      while (this.entries.length > 32) {
        const retired = this.entries.find(
          (e) =>
            e !== entry &&
            !e.pendingDismiss &&
            e.metadata.exitConfirmed &&
            !this.instances.has(terminalKey(e.metadata))
        )
        if (!retired) break
        this.removeEntry(retired)
      }
    }
    return entry
  }
  async create(): Promise<void> {
    const project = this.project
    if (!project || !this.visible || this.busy) return
    // Retain exited screens too. At the bound, the user explicitly closes one before creating another.
    if (this.retainedCount >= 8) {
      this.error = '最多保留 8 个终端屏幕，请先关闭一个；后台已退出的终端需返回所属项目完成关闭。'
      this.notify()
      return
    }
    this.busy = true
    this.error = ''
    this.prompt = null
    this.notify()
    try {
      const result = await window.pi.terminal({
        type: 'create',
        projectPath: project,
        cols: 80,
        rows: 24
      })
      if (this.disposed) return
      if (result.type !== 'terminal') {
        this.error = result.type === 'unavailable' ? result.message : '无法创建终端。'
        return
      }
      const key = terminalKey(result.terminal)
      const entry = this.upsert(this.earlyStates.get(key) ?? result.terminal)
      this.earlyStates.delete(key)
      this.makeInstance(entry)
      this.selection.set(project, key)
      this.syncVisibility()
      if (entry.metadata.state !== 'closing' && this.project === project) await this.attach(entry)
      this.syncVisibility()
      this.focus()
    } catch {
      this.error = '创建终端失败，请重试。'
    } finally {
      this.busy = false
      this.notify()
    }
  }
  private async attach(entry: TerminalEntry): Promise<void> {
    const before = entry.metadata
    const result = await window.pi.terminal({ type: 'attach', ...terminalIdentity(before) })
    if (result.type === 'terminal' && entry.metadata === before) entry.metadata = result.terminal
    else if (result.type === 'terminal' && entry.metadata.connection === 'unattached')
      entry.metadata = { ...entry.metadata, connection: result.terminal.connection }
    else if (result.type === 'unavailable' && this.project === before.projectPath)
      this.error = result.message
  }
  private makeInstance(entry: TerminalEntry): void {
    const identity = terminalIdentity(entry.metadata)
    const key = terminalKey(identity)
    const element = document.createElement('div')
    element.className = 'terminal-session'
    element.dataset.terminalId = identity.terminalId
    element.hidden = true
    this.stage.append(element)
    const terminal = new Terminal({
      cols: entry.metadata.cols,
      rows: entry.metadata.rows,
      scrollback: 2000,
      fontSize: 12,
      fontFamily: 'Menlo, Monaco, monospace',
      cursorBlink: true,
      macOptionIsMeta: true,
      convertEol: false,
      screenReaderMode: true,
      theme: TERMINAL_THEMES[this.theme],
      linkHandler: { activate: () => {} }
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(element)
    let composing = false
    const compositionStart = (): void => {
      composing = true
    }
    const compositionEnd = (): void => {
      composing = false
    }
    element.addEventListener('compositionstart', compositionStart, true)
    element.addEventListener('compositionend', compositionEnd, true)
    // xterm can keep document drag listeners after mousedown. Event.eventPhase is nonzero
    // only during that DOM dispatch; async parser replies have no DOM input origin.
    let dispatchingInput: Event | undefined
    const observeInput = (event: Event): void => {
      dispatchingInput = event
    }
    const documentInputs = [
      'keydown',
      'keyup',
      'keypress',
      'beforeinput',
      'input',
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'paste',
      'mousedown',
      'mouseup',
      'mousemove',
      'wheel'
    ]
    documentInputs.forEach((name) => document.addEventListener(name, observeInput, true))
    const disposables = [
      terminal.onData((data) => {
        // Only reject DOM-origin input of a hidden session, including captured mouse drags.
        // Parser DSR/DA responses always keep their original capability; no VT classification.
        if (
          dispatchingInput &&
          dispatchingInput.eventPhase !== Event.NONE &&
          (!this.active(identity) || this.prompt)
        )
          return
        if (
          !entry.metadata.failure &&
          !entry.metadata.exitConfirmed &&
          entry.metadata.state === 'running'
        )
          void this.sendInput(identity, data, 'utf8')
      }),
      terminal.onBinary((data) => {
        if (this.active(identity) && !this.prompt && this.interactive(entry.metadata))
          void this.sendInput(identity, data, 'binary')
      }),
      terminal.onTitleChange((title) => {
        entry.title = displayTitle(title)
        this.notify()
      }),
      terminal.parser.registerOscHandler(52, () => true)
    ]
    const guard = (event: Event): void => {
      if (!this.active(identity) || this.prompt) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    const events = [
      'keydown',
      'keyup',
      'keypress',
      'beforeinput',
      'input',
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'mousedown',
      'mouseup',
      'wheel'
    ]
    events.forEach((name) => element.addEventListener(name, guard, true))
    const paste = (event: ClipboardEvent): void => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (this.active(identity)) this.requestPaste(event.clipboardData?.getData('text/plain') ?? '')
    }
    element.addEventListener('paste', paste, true)
    terminal.attachCustomKeyEventHandler((event) => {
      if (!this.active(identity) || this.prompt) return false
      if (event.metaKey && event.key.toLowerCase() === 'c') {
        if (event.type === 'keydown' && terminal.hasSelection()) {
          event.preventDefault()
          void navigator.clipboard.writeText(terminal.getSelection()).catch(() => {
            this.error = '复制失败。'
            this.notify()
          })
        }
        return false
      }
      // Native paste events are intercepted above; Cmd+B remains an intentional app shortcut.
      if (event.metaKey && ['v', 'b'].includes(event.key.toLowerCase())) return false
      event.stopPropagation()
      return true
    })
    const observer = new ResizeObserver(() => this.scheduleFit())
    observer.observe(element)
    void document.fonts.ready.then(() => this.scheduleFit())
    this.instances.set(key, {
      terminal,
      fit,
      element,
      cancelComposition: () => {
        // Clear pending IME text before xterm's deferred composition callback can forward it.
        if (terminal.textarea) {
          terminal.textarea.value = ''
          if (composing)
            terminal.textarea.dispatchEvent(
              new CompositionEvent('compositionend', { bubbles: true, data: '' })
            )
        }
      },
      dispose: () => {
        observer.disconnect()
        events.forEach((name) => element.removeEventListener(name, guard, true))
        documentInputs.forEach((name) => document.removeEventListener(name, observeInput, true))
        element.removeEventListener('paste', paste, true)
        element.removeEventListener('compositionstart', compositionStart, true)
        element.removeEventListener('compositionend', compositionEnd, true)
        disposables.forEach((d) => d.dispose())
        terminal.dispose()
        element.remove()
      }
    })
  }
  private async sendInput(
    identity: TerminalIdentity,
    data: string,
    encoding: 'utf8' | 'binary'
  ): Promise<void> {
    try {
      const result = await window.pi.terminal({ type: 'input', ...identity, data, encoding })
      if (result.type === 'unavailable') {
        this.error = result.message
        this.notify()
      }
    } catch {
      this.error = '终端输入未能送达。'
      this.notify()
    }
  }
  private event(event: TerminalEvent): void {
    if (this.disposed) return
    if (event.type === 'state') {
      const key = terminalKey(event.terminal)
      const entry = this.entries.find((e) => terminalKey(e.metadata) === key)
      if (!entry) {
        const previous = this.entries.find(
          (e) => e.metadata.terminalId === event.terminal.terminalId
        )
        if (previous) {
          this.prompt = null
          this.interactionRevision++
          this.upsert(event.terminal)
          if (this.selection.get(previous.metadata.projectPath) === terminalKey(previous.metadata))
            this.selection.set(event.terminal.projectPath, key)
          this.syncVisibility()
          this.notify()
          return
        }
        // Creation can emit state before its IPC reply. Bound the short-lived race cache.
        this.earlyStates.set(key, event.terminal)
        if (this.earlyStates.size > 32)
          this.earlyStates.delete(this.earlyStates.keys().next().value!)
        return
      }
      entry.metadata = event.terminal
      if (
        this.prompt &&
        terminalKey(this.prompt.identity) === key &&
        !this.interactive(entry.metadata)
      )
        this.prompt = null
      this.syncVisibility()
      this.notify()
      return
    }
    const instance = this.instances.get(terminalKey(event))
    if (instance)
      instance.terminal.write(event.data, () => {
        if (!this.disposed && this.instances.get(terminalKey(event)) === instance)
          void window.pi
            .terminal({ type: 'ack', ...terminalIdentity(event), sequence: event.sequence })
            .catch(() => {})
      })
  }
  private syncVisibility(): void {
    for (const [key, instance] of this.instances) {
      const shown = this.visible && !!this.current && key === terminalKey(this.current.metadata)
      instance.element.hidden = !shown
      instance.element.inert = !shown || !!this.prompt
      if (!shown || this.prompt) instance.terminal.blur()
    }
    this.scheduleFit()
  }
  private scheduleFit(): void {
    if (this.frame || this.disposed) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      const entry = this.current
      if (!this.visible || !entry) return
      const instance = this.instances.get(terminalKey(entry.metadata))
      if (!instance || instance.element.clientWidth <= 0 || instance.element.clientHeight <= 0)
        return
      const dimensions = instance.fit.proposeDimensions()
      if (dimensions && dimensions.cols > 0 && dimensions.rows > 0) {
        const cols = Math.min(500, dimensions.cols)
        const rows = Math.min(300, dimensions.rows)
        instance.terminal.resize(cols, rows)
        // A first fit can happen before the PTY accepts resize. Reconcile actual host
        // dimensions on running/attach state, even if the emulator is already the right size.
        if (
          this.interactive(entry.metadata) &&
          entry.metadata.state === 'running' &&
          (entry.metadata.cols !== cols || entry.metadata.rows !== rows)
        )
          void window.pi
            .terminal({ type: 'resize', ...terminalIdentity(entry.metadata), cols, rows })
            .catch(() => {
              this.error = '终端尺寸同步失败，请调整面板后重试。'
              this.notify()
            })
      }
    })
  }
  focus(): void {
    if (this.current && this.visible && !this.prompt && this.interactive(this.current.metadata))
      this.instances.get(terminalKey(this.current.metadata))?.terminal.focus()
  }
  private cancelComposition(): void {
    if (this.current) this.instances.get(terminalKey(this.current.metadata))?.cancelComposition()
  }
  requestPaste(text: string): void {
    const entry = this.current
    if (!entry || !this.active(entry.metadata) || !this.interactive(entry.metadata) || this.prompt)
      return
    const safety = pasteSafety(text)
    if (safety === 'oversized') this.error = '粘贴内容超过 8 KiB，未发送任何内容。请缩短后重试。'
    if (safety === 'safe') this.instances.get(terminalKey(entry.metadata))?.terminal.paste(text)
    if (safety === 'confirm') {
      this.cancelComposition()
      this.prompt = { kind: 'paste', identity: terminalIdentity(entry.metadata), text }
    }
    this.syncVisibility()
    this.notify()
  }
  requestClose(recreate = false): void {
    if (!this.current || !this.visible || this.busy || this.current.metadata.state === 'closing')
      return
    this.cancelComposition()
    this.prompt = {
      kind: recreate ? 'recreate' : 'close',
      identity: terminalIdentity(this.current.metadata)
    }
    this.syncVisibility()
    this.notify()
  }
  cancel(): void {
    this.prompt = null
    this.syncVisibility()
    this.notify()
    this.focus()
  }
  async confirm(): Promise<void> {
    const prompt = this.prompt
    if (!prompt || !this.active(prompt.identity) || this.busy) return
    this.prompt = null
    const revision = this.interactionRevision
    const entry = this.current!
    if (prompt.kind === 'paste') {
      if (this.interactive(entry.metadata))
        this.instances.get(terminalKey(prompt.identity))?.terminal.paste(prompt.text!)
      this.syncVisibility()
      this.notify()
      this.focus()
      return
    }
    if (!this.currentHasScreen && !entry.pendingDismiss && this.retainedCount >= 8) {
      this.error = '已有 8 个保留终端，请先返回所属项目完成待同步关闭。'
      this.syncVisibility()
      this.notify()
      return
    }
    this.busy = true
    this.notify()
    let alreadyDismissed = false
    try {
      {
        const before = entry.metadata
        const result = await window.pi.terminal({ type: 'close', ...prompt.identity })
        alreadyDismissed = result.type === 'ok'
        if (alreadyDismissed) entry.pendingDismiss = false
        if (result.type === 'unavailable') {
          this.closeError(entry, result.message)
          return
        }
        if (result.type === 'terminal' && entry.metadata === before)
          entry.metadata = result.terminal
        const deadline = Date.now() + 6500
        while (!entry.metadata.exitConfirmed && Date.now() < deadline && !this.disposed) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      if (!entry.metadata.exitConfirmed) {
        this.closeError(entry, '尚未确认 shell 退出，未新建终端。请稍后重试结束。')
        return
      }
      if (!alreadyDismissed && this.project === prompt.identity.projectPath) {
        const dismissed = await window.pi.terminal({ type: 'close', ...prompt.identity })
        entry.pendingDismiss = dismissed.type !== 'ok'
      } else if (!alreadyDismissed) entry.pendingDismiss = true
      if (entry.pendingDismiss) {
        this.closeError(entry, 'Shell 已退出，屏幕仍保留。请返回所属项目完成关闭。')
        return
      }
      this.removeEntry(entry)
      if (
        prompt.kind === 'recreate' &&
        revision === this.interactionRevision &&
        this.project === prompt.identity.projectPath &&
        this.visible
      ) {
        this.busy = false
        await this.create()
      }
    } catch {
      this.closeError(entry, '结束终端失败，未新建终端。')
    } finally {
      this.busy = false
      this.syncVisibility()
      this.notify()
    }
  }
  private disposeInstance(key: string): void {
    this.instances.get(key)?.dispose()
    this.instances.delete(key)
  }
  private removeEntry(entry: TerminalEntry): void {
    const key = terminalKey(entry.metadata)
    if (this.closeErrorOwner === key) this.error = ''
    this.disposeInstance(key)
    this.entries = this.entries.filter((e) => e !== entry)
    if (this.selection.get(entry.metadata.projectPath) === key) {
      const next = this.entries.find((e) => e.metadata.projectPath === entry.metadata.projectPath)
      if (next) this.selection.set(entry.metadata.projectPath, terminalKey(next.metadata))
      else this.selection.delete(entry.metadata.projectPath)
    }
  }
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    cancelAnimationFrame(this.frame)
    for (const key of this.instances.keys()) this.disposeInstance(key)
  }
}
