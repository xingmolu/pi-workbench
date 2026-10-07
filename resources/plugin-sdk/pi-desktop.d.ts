/**
 * Types for Pi Desktop plugins (manifest schemaVersion 1).
 *
 * Plugin code is plain JavaScript; editors read these types through `jsconfig.json`
 * (`"checkJs": true`), so there is nothing to build. The plugin process gets a global `pi`;
 * panel pages get `window.piPlugin`. See PLUGINS.md for the rules behind each method.
 */

declare namespace PiDesktop {
  /** Every host call rejects with one of these codes. */
  type ErrorCode =
    | 'PERMISSION_DENIED'
    | 'INVALID_ARGUMENT'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'TIMEOUT'
    | 'PLUGIN_CRASHED'
    | 'UNSUPPORTED'
    | 'INTERNAL'

  /** In the plugin process this is an `Error`; in a panel a plain object with the same fields. */
  interface ApiError {
    name: 'PluginApiError'
    code: ErrorCode
    message: string
  }

  type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

  type Permission =
    | 'ui.view'
    | 'ui.command'
    | 'ui.theme'
    | 'notify'
    | 'storage'
    | 'fs.read'
    | 'git.read'
    | 'forge.read'
    | 'chat.draft'
    | 'ai.complete'
    | 'clipboard.write'
    | 'shell.openExternal'
    | 'fs.write'
    | 'git.write'
    | 'git.push'
    | 'forge.write'
    | 'agent.tools'
    | 'agent.skills'
    | 'mcp.local'
    | 'mcp.remote'
    | 'net.fetch'

  type FileKind = 'file' | 'directory' | 'symlink' | 'other'

  interface FileEntry {
    name: string
    kind: FileKind
  }

  interface GitStatus {
    branch: string | null
    /** The tracked remote branch, e.g. `origin/main`; null before the first push. */
    upstream: string | null
    ahead: number
    behind: number
    /** `index` and `worktree` are porcelain status letters, e.g. `M`, `A`, `?`. */
    files: { path: string; index: string; worktree: string }[]
  }

  interface GitCommit {
    hash: string
    subject: string
    author: string
    date: string
  }

  /** The project's code host and pull requests; see `src/shared/forge.ts` in Pi Desktop. */
  interface ForgeRepository {
    provider: 'github' | 'gitee' | null
    host: string | null
    owner: string | null
    repo: string | null
    webUrl: string | null
    signedIn: boolean
    viewer: string | null
    reason?: string
  }

  interface ForgePullSummary {
    number: number
    title: string
    author: string
    draft: boolean
    headRef: string
    baseRef: string
    updatedAt: string
    url: string
  }

  interface ForgePullDetail extends ForgePullSummary {
    body: string
    state: 'open' | 'closed' | 'merged'
    mergeable: boolean | null
    mergeableState: string | null
    headSha: string
    additions: number
    deletions: number
    changedFiles: number
    comments: number
    checks: { name: string; status: string; conclusion: string | null; url: string | null }[]
    reviews: { author: string; state: string; submittedAt: string | null }[]
    stack: { number: number; title: string; current: boolean }[]
  }

  interface ForgePullFile {
    path: string
    previousPath?: string
    status: string
    additions: number
    deletions: number
    patch?: string
  }

  /** Host methods by name, with their parameters and results. Paths are relative to the
   * open project and use forward slashes. */
  interface HostMethods {
    /** Needs no permission; the toast names the plugin. */
    'ui.showToast': { params: { message: string }; result: void }
    'ui.notify': { params: { message: string }; result: void }
    /** `ui.view`: reveals one of the plugin's own views. */
    'ui.openView': { params: { id: string }; result: void }
    'ui.openPanel': { params: Record<string, never>; result: void }
    /** `storage`: per plugin and per project; values up to 32 KiB of JSON. */
    'storage.get': { params: { key: string }; result: Json }
    'storage.set': { params: { key: string; value: Json }; result: void }
    'project.current': { params: Record<string, never>; result: { path: string | null } }
    'workspace.get': {
      params: Record<string, never>
      result: { path: string; name: string } | null
    }
    'app.getAppearance': { params: Record<string, never>; result: { base: 'light' | 'dark' } }
    'plugin.getSettings': { params: Record<string, never>; result: Record<string, Json> }
    /** `fs.read`: at most 2000 entries; `.git` is skipped. */
    'fs.list': {
      params: { path?: string }
      result: { entries: FileEntry[]; truncated: boolean }
    }
    'fs.stat': {
      params: { path: string }
      result: { kind: FileKind; size: number; modified: string }
    }
    /** `fs.read`: UTF-8 text up to 1 MiB. */
    'fs.readText': { params: { path: string }; result: { text: string } }
    /** `fs.write`: follows the project's approval level; undoable. */
    'fs.writeText': { params: { path: string; content: string }; result: void }
    'git.status': { params: Record<string, never>; result: GitStatus }
    'git.diff': { params: { path?: string; staged?: boolean }; result: { patch: string } }
    'git.log': { params: { limit?: number }; result: { commits: GitCommit[] } }
    'git.stage': { params: { paths: string[] }; result: void }
    'git.unstage': { params: { paths: string[] }; result: void }
    'git.discard': { params: { paths: string[] }; result: void }
    'git.commit': { params: { message: string }; result: { hash: string } }
    /** `git.push`: always asks the user, at every approval level. */
    'git.push': { params: Record<string, never>; result: { remote: string; branch: string } }
    /** Commits on the current branch that its remote does not have, with their patch. */
    'git.outgoing': {
      params: Record<string, never>
      result: {
        branch: string | null
        base: string | null
        commits: GitCommit[]
        moreCommits: number
        patch: string
      }
    }
    'forge.repository': { params: Record<string, never>; result: ForgeRepository }
    'forge.pulls': {
      params: Record<string, never>
      result: {
        viewer: string | null
        mine: ForgePullSummary[]
        reviewRequested: ForgePullSummary[]
        others: ForgePullSummary[]
      }
    }
    'forge.pull': { params: { number: number }; result: ForgePullDetail }
    'forge.pullFiles': { params: { number: number }; result: ForgePullFile[] }
    /** Always asks the user; merges only if the head is still `headSha`. */
    'forge.merge': {
      params: { number: number; method: 'merge' | 'squash' | 'rebase'; headSha: string }
      result: void
    }
    /** Always asks the user. */
    'forge.comment': { params: { number: number; body: string }; result: { url: string } }
    /** A new conversation in the open project with `text` in its composer; never sends. */
    'chat.draft': { params: { text: string }; result: void }
    /** `ai.complete`: a short answer from the user's model. Small fast models are tried first
     * (or the one chosen in Settings), then the open session's. `model` is `provider/model`. */
    'ai.complete': {
      params: { system?: string; prompt: string; maxTokens?: number }
      result: { text: string; model: string }
    }
    'ui.openSettings': { params: { section: 'forges' }; result: void }
    /** Opens an https link in the user's browser. */
    'shell.openExternal': { params: { url: string }; result: void }
  }

  type HostMethod = keyof HostMethods

  /** What a tool handler returns: text, MCP-style text content, or JSON shown to the model. */
  type ToolResult = string | { content: { type: 'text'; text: string }[] } | Json

  interface ToolContext {
    pluginId: string
    /** Written to the plugin's log in Settings. */
    log(message: string): void
  }

  /** The global `pi` in the plugin process (`main`). Every method returns a Promise. */
  interface ProcessApi {
    commands: {
      /** `ui.command`: binds a command declared in `contributes.commands`. Runs from ⌘K. */
      register(command: { id: string; run(): unknown }): Promise<void>
      unregister(id: string): Promise<void>
    }
    ui: {
      showToast(message: string | { message: string }): Promise<void>
      notify(message: string | { message: string }): Promise<void>
      openView(id: string): Promise<void>
      openPanel(): Promise<void>
    }
    plugin: {
      getId(): string
      getSettings(): Promise<Record<string, Json>>
      /** Only keys declared in `contributes.settings`, with matching types. */
      setSettings(values: Record<string, Json>): Promise<Record<string, Json>>
      /** A private directory for the plugin's own files. */
      getDataPath(): Promise<string>
    }
    storage: {
      get<T extends Json = Json>(key: string): Promise<T | null>
      set(key: string, value: Json): Promise<void>
    }
    project: {
      current(): Promise<{ path: string | null }>
    }
    fs: {
      list(path?: string): Promise<HostMethods['fs.list']['result']>
      stat(path: string): Promise<HostMethods['fs.stat']['result']>
      readText(path: string): Promise<{ text: string }>
      writeText(path: string, content: string): Promise<void>
    }
    ai: {
      complete(
        request: HostMethods['ai.complete']['params']
      ): Promise<HostMethods['ai.complete']['result']>
    }
    git: {
      status(): Promise<GitStatus>
      diff(options?: { path?: string; staged?: boolean }): Promise<{ patch: string }>
      log(options?: { limit?: number }): Promise<{ commits: GitCommit[] }>
      stage(paths: string[]): Promise<void>
      unstage(paths: string[]): Promise<void>
      discard(paths: string[]): Promise<void>
      commit(message: string): Promise<{ hash: string }>
      push(): Promise<{ remote: string; branch: string }>
    }
    agent: {
      /** `agent.tools`: binds a tool declared in `contributes.agentTools`. The input has
       * already been validated against its `parameters` schema. */
      registerTool(tool: {
        name: string
        run?(input: any, context: ToolContext): ToolResult | Promise<ToolResult>
        execute?(input: any, context: ToolContext): ToolResult | Promise<ToolResult>
      }): Promise<void>
      unregisterTool(name: string): Promise<void>
    }
  }

  /** What `main` exports (CommonJS `module.exports` or an ES module's default export). */
  interface PluginModule {
    onLoad?(): unknown
    onUnload?(): unknown
    /** Panel calls to channels the host does not implement come here. */
    onPanelInvoke?(channel: string, payload: unknown): unknown
  }

  interface PanelContext {
    pluginId: string
    viewId: string
    projectPath: string | null
    sessionId: string | null
    generation: number
  }

  /** `window.piPlugin` in a panel page. */
  interface PanelApi {
    /** The interface language. */
    readonly locale: 'zh-CN' | 'en'
    /** `mobile` when the page is shown on a paired phone. */
    readonly surface?: 'desktop' | 'mobile'
    getContext(): Promise<PanelContext>
    /** Called when the project or session changes. Returns an unsubscribe function. */
    onContext(listener: (context: PanelContext) => void): () => void
    /** Panel state for this view and project; pass the context's `generation`. */
    getState(generation: number): Promise<Json>
    setState(generation: number, value: Json): Promise<void>
    /** Calls a host method with this plugin's permissions. Commands and tools are process only. */
    call<M extends HostMethod>(
      method: M,
      params?: HostMethods[M]['params']
    ): Promise<HostMethods[M]['result']>
    /** A channel handled by the plugin process's `onPanelInvoke`. */
    call(method: string, params?: Json): Promise<Json>
  }
}

declare var pi: PiDesktop.ProcessApi

interface Window {
  piPlugin: PiDesktop.PanelApi
}
