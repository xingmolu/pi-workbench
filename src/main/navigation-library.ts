import { isAbsolute, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import {
  emptyNavigationLibrary,
  navigationLibraryCommandSchema,
  navigationLibrarySchema,
  type NavigationLibraryState
} from '../shared/navigation-library'

export type NavigationLibraryOptions = {
  store: {
    get(key: 'navigationLibrary'): unknown
    set(key: 'navigationLibrary', state: NavigationLibraryState): void
  }
  normalize?: (path: string) => Promise<string>
  now?: () => number
  /** Must inspect authoritative worker state, not a renderer-supplied status. */
  mutationReason: (cwd: string, path?: string) => string | null
  renamedSession: (cwd: string, path: string, name: string) => Promise<void>
  hiddenProject: (cwd: string) => void
  archivedSession: (cwd: string, path: string) => void
  reveal: (cwd: string) => Promise<void>
  copyPath: (cwd: string) => void
  changed: (state: NavigationLibraryState) => void
}

/** Serialized, native-owned presentation mutations. No delete/unlink/rm operations. */
export class NavigationLibrary {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: NavigationLibraryOptions) {}

  read(): NavigationLibraryState {
    const saved = this.options.store.get('navigationLibrary')
    if (saved === undefined) return emptyNavigationLibrary()
    const parsed = navigationLibrarySchema.safeParse(saved)
    if (!parsed.success) throw new Error('项目管理设置不可读取；原数据未修改，请检查偏好文件后重试')
    return parsed.data
  }

  private persist(state: NavigationLibraryState): NavigationLibraryState {
    const next = navigationLibrarySchema.parse({ ...state, revision: state.revision + 1 })
    this.options.store.set('navigationLibrary', next)
    this.options.changed(next)
    return next
  }

  /** Only call after Main has successfully opened this canonical project/session. */
  restoreAfterOpen(cwd: string, path?: string | null): void {
    const state = this.read()
    let changed = false
    if (state.projects[cwd]?.hiddenAt !== undefined) {
      delete state.projects[cwd].hiddenAt
      changed = true
    }
    if (path && state.sessions[path]?.archivedAt !== undefined) {
      delete state.sessions[path].archivedAt
      changed = true
    }
    if (changed) this.persist(state)
  }

  dispatch(value: unknown): Promise<NavigationLibraryState> {
    const command = navigationLibraryCommandSchema.parse(value)
    const operation = this.tail.then(async () => {
      if (command.type === 'get') return this.read()
      if (command.type === 'layout:save') {
        const state = this.read()
        state.layout = { ...state.layout, ...command.layout }
        return this.persist(state)
      }
      const canonical = async (value: string): Promise<string> => {
        if (!isAbsolute(value)) throw new Error('需要绝对路径')
        // A missing project can still be removed/restored. Never resolve a relative path.
        return (this.options.normalize ?? realpath)(value).catch(() => resolve(value))
      }
      const cwd = await canonical(command.cwd)
      if (command.type === 'project:reveal') {
        await this.options.reveal(cwd)
        return this.read()
      }
      if (command.type === 'project:copy-path') {
        this.options.copyPath(cwd)
        return this.read()
      }
      const path = 'path' in command ? await canonical(command.path) : undefined
      const hides =
        command.type === 'project:hide' || (command.type === 'session:archive' && command.archived)
      if (hides || command.type === 'session:rename') {
        const reason = this.options.mutationReason(cwd, hides ? undefined : path)
        if (reason) throw new Error(reason)
      }
      if (command.type === 'session:rename') {
        // Reuse the existing runtime rename command and its identity/persistence guards.
        await this.options.renamedSession(cwd, path!, command.name)
      }
      // Read after awaits, so simultaneous successful opens cannot be overwritten.
      const state = this.read()
      const now = (this.options.now ?? Date.now)()
      if (path) {
        const entry = { ...state.sessions[path], cwd }
        if (command.type === 'session:rename') entry.title = command.name
        if (command.type === 'session:pin') {
          entry.title = command.title
          if (command.pinned) entry.pinnedAt ??= now
          else delete entry.pinnedAt
        }
        if (command.type === 'session:archive') {
          entry.title = command.title
          if (command.archived) entry.archivedAt = now
          else delete entry.archivedAt
        }
        state.sessions[path] = entry
      } else {
        const entry = { ...state.projects[cwd] }
        if (command.type === 'project:rename') {
          if (command.name) entry.name = command.name
          else delete entry.name
        }
        if (command.type === 'project:pin') {
          if (command.pinned) entry.pinnedAt ??= now
          else delete entry.pinnedAt
        }
        if (command.type === 'project:hide') entry.hiddenAt = now
        if (command.type === 'project:restore') delete entry.hiddenAt
        state.projects[cwd] = entry
      }
      // No await between the final authoritative guard, persistence and foreground detach.
      if (hides) {
        const reason = this.options.mutationReason(cwd, hides ? undefined : path)
        if (reason) throw new Error(reason)
      }
      const next = this.persist(state)
      if (command.type === 'project:hide') this.options.hiddenProject(cwd)
      if (command.type === 'session:archive' && command.archived)
        this.options.archivedSession(cwd, path!)
      return next
    })
    this.tail = operation.catch(() => {})
    return operation
  }
}
