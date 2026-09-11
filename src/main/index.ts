import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  utilityProcess,
  type BrowserWindow as BrowserWindowType,
  type IpcMainInvokeEvent,
  type UtilityProcess
} from 'electron'
import { randomUUID } from 'node:crypto'
import { MarkdownTableExporter } from './markdown-table-export'
import { MARKDOWN_TABLE_EXPORT_CHANNEL } from '../shared/markdown-table-export'
import { TextAttachments } from './text-attachments'
import { AttachmentSubmissions } from './attachment-submissions'
import {
  TEXT_ATTACHMENT_CHANNEL,
  attachmentCommandSchema,
  formatTextContext
} from '../shared/text-attachments'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import type ElectronStore from 'electron-store'
import type {
  AgentSnapshot,
  BrowserCapabilityResponse,
  BrowserCommand,
  HostCommand,
  DesktopEvent,
  HostRequest,
  HostResult,
  SnapshotHostCommand,
  WorkbenchEvent
} from '../shared/contracts'
import {
  BUILTIN_BROWSER_VIEW_ID,
  WORKBENCH_CHANNEL,
  WORKBENCH_EVENT_CHANNEL,
  WORKBENCH_PANEL_CHANNEL
} from '../shared/workbench-contracts'
import {
  browserCapabilityCancelSchema,
  browserCapabilityRequestSchema,
  browserCommandSchema,
  hostCommandSchema
} from '../shared/schemas'
import { workbenchCommandSchema } from '../shared/workbench-schemas'
import { WORKSPACE_FILES_CHANNEL, workspaceFilesCommandSchema } from '../shared/workspace-files'
import { WorkspaceFiles } from './workspace-files'
import { GIT_REVIEW_CHANNEL, gitReviewCommandSchema } from '../shared/git-review'
import { GitReview } from './git-review'
import { TerminalManager } from './terminal-manager'
import { TERMINAL_CHANNEL, TERMINAL_EVENT_CHANNEL } from '../shared/terminal'
import { BrowserManager } from './browser-manager'
import { HostResponseBroker } from './host-response-broker'
import { assertE2EModeAllowed, canonicalExistingTempDirectory } from './e2e-temp-directory'
import { loadElectronStoreConstructor } from './electron-store-interop'
import { ProjectOpenCoordinator } from './project-open-coordinator'
import { pathToPersistAfterOpen, resolveExistingProjectPath } from './recent-project'
import { mergeRecentProjects } from './recent-projects'
import {
  createWorkbenchHost,
  createWorkbenchPanelStateAdapter,
  type WorkbenchHost
} from './workbench-host'
import type { WorkbenchStateStore } from './workbench-host-state'
import { createWorkbenchPanelIpcRouter } from './workbench-panel-ipc'
import { createPiPackageRootsLifecycle } from './workbench-package-roots'
import icon from '../../resources/icon.png?asset'

const E2E_MODE = process.env['PI_DESKTOP_E2E'] === '1'
assertE2EModeAllowed(E2E_MODE, app.isPackaged)

function requiredE2ETempPath(
  name: 'PI_DESKTOP_E2E_USER_DATA' | 'PI_DESKTOP_E2E_AGENT_DIR'
): string {
  return canonicalExistingTempDirectory(process.env[name], name)
}

const e2eAgentDir = E2E_MODE ? requiredE2ETempPath('PI_DESKTOP_E2E_AGENT_DIR') : null
if (E2E_MODE) app.setPath('userData', requiredE2ETempPath('PI_DESKTOP_E2E_USER_DATA'))

let agentHost: UtilityProcess | null = null
let hostSpawned = false
let hostReady: Promise<void> | null = null
let resolveHostReady: (() => void) | null = null
let rejectHostReady: ((error: Error) => void) | null = null
let preferences: ElectronStore<Preferences> | null = null
let browserManager: BrowserManager | null = null
let browserOwner: BrowserWindowType | null = null
let workbenchHost: WorkbenchHost | null = null
let activeHostIdentity: Pick<AgentSnapshot, 'sessionId' | 'generation'> = {
  sessionId: null,
  generation: 0
}
let activeProjectPath: string | null = null
const workspaceFiles = new WorkspaceFiles()
const textAttachments = new TextAttachments()
const attachmentSubmissions = new AttachmentSubmissions()
let gitReview: GitReview | null = null
const terminalManager = new TerminalManager({
  canonicalProject: resolveExistingProjectPath,
  startHost: async (handlers) => {
    let account: { homedir: string; username: string; shell: string | null }
    try {
      account = userInfo()
    } catch {
      account = { homedir: homedir(), username: 'user', shell: '/bin/zsh' }
    }
    const terminalHome = E2E_MODE
      ? canonicalExistingTempDirectory(
          await mkdtemp(join(e2eAgentDir!, 'terminal-home-')),
          'Terminal fixture HOME'
        )
      : account.homedir
    const loginShell =
      account.shell && isAbsolute(account.shell) && !account.shell.includes('\0')
        ? account.shell
        : '/bin/zsh'
    const terminalEnv: Record<string, string> = {
      HOME: terminalHome,
      USER: E2E_MODE ? 'terminal-fixture' : account.username,
      LOGNAME: E2E_MODE ? 'terminal-fixture' : account.username,
      SHELL: E2E_MODE ? '/bin/zsh' : loginShell,
      PATH: E2E_MODE
        ? '/usr/bin:/bin:/usr/sbin:/sbin'
        : '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      TMPDIR: app.getPath('temp'),
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'PiDesktop'
    }
    if (E2E_MODE) terminalEnv.ZDOTDIR = terminalHome
    return new Promise((resolve, reject) => {
      const child = utilityProcess.fork(
        join(__dirname, 'terminal-host.js'),
        E2E_MODE ? ['--isolated-terminal-fixture'] : [],
        {
          serviceName: 'Pi User Terminal Host',
          stdio: 'pipe',
          env: terminalEnv
        }
      )
      // Deliberately drain without logging terminal data or native exception payloads.
      child.stdout?.resume()
      child.stderr?.on('data', () => handlers.diagnostic())
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error('终端服务启动超时'))
      }, 4000)
      child.on('message', handlers.message)
      child.on('exit', () => {
        clearTimeout(timeout)
        handlers.exit()
        reject(new Error('终端服务已退出'))
      })
      child.on('error', () => {
        clearTimeout(timeout)
        child.kill()
        handlers.exit()
        reject(new Error('终端服务启动失败'))
      })
      child.once('spawn', () => {
        clearTimeout(timeout)
        resolve(child)
      })
    })
  }
})
let activeSessionPath: string | null = null
let recoveryTarget: { project: string | null; session: string | null } | null = null
let reconnectingHost: Promise<AgentSnapshot> | null = null
const packageRootsLifecycle = createPiPackageRootsLifecycle({
  initialIdentity: activeHostIdentity,
  warn: (warning) => console.warn(warning)
})
const AUTH_EXTERNAL_HOSTS = new Set(['auth.openai.com'])
const responseBroker = new HostResponseBroker({
  onInvalid: (message) => console.warn('忽略无效 Agent Host 消息', message)
})
const projectOpenCoordinator = new ProjectOpenCoordinator<AgentSnapshot>()
const workbenchPanelIpc = createWorkbenchPanelIpcRouter({
  createAdapter: createWorkbenchPanelStateAdapter
})

type Preferences = {
  recentProjects?: string[]
  lastProjectPath?: string
  workbenchDesktopEnabled?: Record<string, boolean>
  workbenchPanelState?: Record<string, unknown>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function updateWorkbenchContext(): void {
  attachmentSubmissions.setContext(
    activeProjectPath && activeHostIdentity.sessionId
      ? {
          projectPath: activeProjectPath,
          sessionId: activeHostIdentity.sessionId,
          generation: activeHostIdentity.generation
        }
      : null
  )
  textAttachments.setContext(
    activeProjectPath && activeHostIdentity.sessionId
      ? {
          projectPath: activeProjectPath,
          sessionId: activeHostIdentity.sessionId,
          generation: activeHostIdentity.generation
        }
      : null
  )
  workspaceFiles.setProject(activeProjectPath)
  gitReview?.setProject(activeProjectPath)
  terminalManager.setProject(activeProjectPath ?? recoveryTarget?.project ?? null)
  const host = workbenchHost
  if (!host) return
  try {
    host.setContext({
      projectPath: activeProjectPath,
      sessionId: activeHostIdentity.sessionId,
      generation: activeHostIdentity.generation
    })
  } catch (error) {
    console.warn('忽略过期的 Workbench 上下文', errorMessage(error))
  }
}

function forwardEvent(event: DesktopEvent): void {
  if (event.event === 'snapshot' || event.event === 'patch') {
    const nextIdentity = {
      sessionId: event.data.sessionId,
      generation: event.data.generation
    }
    packageRootsLifecycle.transitionIdentity(nextIdentity, () => {
      activeHostIdentity = nextIdentity
      if (event.event === 'snapshot') {
        activeSessionPath = event.data.activeSessionPath
        activeProjectPath = event.data.project?.path ?? null
        browserManager?.setProject(activeProjectPath)
      }
      if (event.event === 'patch' && 'project' in event.data.meta) {
        activeProjectPath = event.data.meta.project?.path ?? null
        browserManager?.setProject(activeProjectPath)
      }
      if (event.event === 'patch' && 'activeSessionPath' in event.data.meta) {
        activeSessionPath = event.data.meta.activeSessionPath ?? null
      }
      updateWorkbenchContext()
    })
  }
  if (event.event === 'open-external') {
    try {
      const target = new URL(event.data.url)
      if (target.protocol === 'https:' && AUTH_EXTERNAL_HOSTS.has(target.hostname)) {
        void shell.openExternal(target.toString())
      }
    } catch {
      // Ignore malformed provider URLs rather than handing them to the OS.
    }
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('pi:event', event)
  }
}

function handleHostMessage(message: unknown): void {
  if (packageRootsLifecycle.handleMessage(message)) return
  const capabilityRequest = browserCapabilityRequestSchema.safeParse(message)
  if (capabilityRequest.success) {
    const request = capabilityRequest.data
    if (
      request.generation !== activeHostIdentity.generation ||
      request.sessionId !== activeHostIdentity.sessionId
    ) {
      agentHost?.postMessage({
        type: 'capability-response',
        capability: 'browser',
        requestId: request.requestId,
        ok: false,
        error: '会话已切换，浏览器操作已取消'
      } satisfies BrowserCapabilityResponse)
      return
    }
    const manager = browserManager
    if (!manager) {
      agentHost?.postMessage({
        type: 'capability-response',
        capability: 'browser',
        requestId: request.requestId,
        ok: false,
        error: '浏览器工作台尚未就绪'
      } satisfies BrowserCapabilityResponse)
      return
    }
    browserOwner?.webContents.send(WORKBENCH_EVENT_CHANNEL, {
      type: 'reveal',
      viewId: BUILTIN_BROWSER_VIEW_ID
    } satisfies WorkbenchEvent)
    void manager
      .executeAgent(request.operation, request.requestId)
      .then((data) => {
        agentHost?.postMessage({
          type: 'capability-response',
          capability: 'browser',
          requestId: request.requestId,
          ok: true,
          data
        } satisfies BrowserCapabilityResponse)
      })
      .catch((error) => {
        agentHost?.postMessage({
          type: 'capability-response',
          capability: 'browser',
          requestId: request.requestId,
          ok: false,
          error: errorMessage(error)
        } satisfies BrowserCapabilityResponse)
      })
    return
  }
  const capabilityCancel = browserCapabilityCancelSchema.safeParse(message)
  if (capabilityCancel.success) {
    browserManager?.abortAgent(capabilityCancel.data.requestId)
    return
  }
  const event = responseBroker.accept(message)
  if (event) forwardEvent(event)
}

async function callHost(command: HostCommand): Promise<HostResult> {
  if (!hostSpawned) {
    if (!hostReady) throw new Error('Agent Host 尚未启动')
    await hostReady
  }
  if (!agentHost) throw new Error('Agent Host 尚未就绪')

  return responseBroker.request(command, (request) => {
    if (!agentHost) throw new Error('Agent Host 尚未就绪')
    agentHost.postMessage(request)
  })
}

async function callHostSnapshot(command: SnapshotHostCommand): Promise<AgentSnapshot> {
  const result = await callHost(command)
  if (result.kind !== 'snapshot') {
    throw new Error(`Agent Host 未返回状态快照：${command.type}`)
  }
  const nextIdentity = {
    sessionId: result.snapshot.sessionId,
    generation: result.snapshot.generation
  }
  packageRootsLifecycle.transitionIdentity(nextIdentity, () => {
    activeHostIdentity = nextIdentity
    activeProjectPath = result.snapshot.project?.path ?? null
    activeSessionPath = result.snapshot.activeSessionPath
    browserManager?.setProject(activeProjectPath)
    updateWorkbenchContext()
  })
  return result.snapshot
}

function preferenceStore(): ElectronStore<Preferences> {
  if (!preferences) throw new Error('偏好存储尚未就绪')
  return preferences
}

async function openCanonicalProject(canonicalPath: string): Promise<AgentSnapshot> {
  const snapshot = await callHostSnapshot({ type: 'project:open', cwd: canonicalPath })
  const persistedPath = pathToPersistAfterOpen(canonicalPath, snapshot)
  if (!persistedPath) throw new Error('Agent Host 未确认所选工作区')
  preferenceStore().set('lastProjectPath', persistedPath)
  preferenceStore().set('recentProjects', mergeRecentProjects(preferenceStore().get('recentProjects'), persistedPath))
  return snapshot
}

async function openUserProject(candidatePath: unknown): Promise<AgentSnapshot> {
  const canonicalPath = await resolveExistingProjectPath(candidatePath)
  if (!canonicalPath) throw new Error('所选工作区不存在或不是文件夹')
  return projectOpenCoordinator.runUserOpen(() => openCanonicalProject(canonicalPath))
}

async function attemptRecentProjectRestore(): Promise<AgentSnapshot | null> {
  const store = preferenceStore()
  const storedPath = store.get('lastProjectPath')
  if (storedPath === undefined) return null

  const canonicalPath = await resolveExistingProjectPath(storedPath)
  if (!canonicalPath) {
    store.delete('lastProjectPath')
    return null
  }

  try {
    return await openCanonicalProject(canonicalPath)
  } catch (error) {
    store.delete('lastProjectPath')
    console.warn('无法恢复最近工作区', errorMessage(error))
    return null
  }
}

function startAgentHost(): void {
  packageRootsLifecycle.hostStarted()
  hostReady = new Promise((resolve, reject) => {
    resolveHostReady = resolve
    rejectHostReady = reject
  })
  void hostReady.catch(() => undefined)
  const script = join(__dirname, 'agent-host.js')
  agentHost = utilityProcess.fork(script, [], {
    serviceName: 'Pi Agent Host',
    stdio: 'pipe',
    ...(e2eAgentDir
      ? {
          env: {
            ...process.env,
            PI_DESKTOP_E2E: '1',
            PI_DESKTOP_E2E_AGENT_DIR: e2eAgentDir
          }
        }
      : {})
  })

  agentHost.stdout?.on('data', (chunk) => {
    if (is.dev) process.stdout.write(`[agent-host] ${String(chunk)}`)
  })
  agentHost.stderr?.on('data', (chunk) => {
    process.stderr.write(`[agent-host] ${String(chunk)}`)
  })
  agentHost.on('spawn', () => {
    hostSpawned = true
    resolveHostReady?.()
    resolveHostReady = null
    rejectHostReady = null
    agentHost?.postMessage({ type: 'bootstrap', requestId: randomUUID() } satisfies HostRequest)
  })
  agentHost.on('error', (error) => {
    packageRootsLifecycle.hostExited()
    console.error('Agent Host 进程错误', errorMessage(error))
  })
  agentHost.on('message', handleHostMessage)
  agentHost.on('exit', (code) => {
    recoveryTarget ??= { project: activeProjectPath, session: activeSessionPath }
    activeProjectPath = null
    terminalManager.setProject(recoveryTarget?.project ?? null)
    workspaceFiles.setProject(null)
    textAttachments.setContext(null)
    attachmentSubmissions.setContext(null)
    gitReview?.setProject(null)
    packageRootsLifecycle.hostExited()
    hostSpawned = false
    agentHost = null
    browserManager?.abortAgent()
    const failure = new Error(`Agent Host 已退出（code ${code}）`)
    if (code !== 0) console.error(failure.message)
    rejectHostReady?.(failure)
    resolveHostReady = null
    rejectHostReady = null
    hostReady = null
    responseBroker.rejectAll(failure)
    forwardEvent({
      type: 'event',
      event: 'disconnected',
      data: {
        message: 'Pi 引擎已断开。草稿和当前画布已保留，重新连接后不会自动重发任务。'
      }
    })
  })
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('拒绝非主窗口 IPC 请求')
  }
  const source = new URL(event.senderFrame.url)
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && rendererUrl) {
    if (source.origin !== new URL(rendererUrl).origin) {
      throw new Error('拒绝非本地开发页面 IPC 请求')
    }
  } else if (source.href !== pathToFileURL(join(__dirname, '../renderer/index.html')).href) {
    throw new Error('拒绝非应用页面 IPC 请求')
  }
}

function registerIpc(): void {
  const tableExporter = new MarkdownTableExporter((owner) => dialog.showSaveDialog(BrowserWindow.fromId(owner.id)!, { title: '保存表格 CSV', defaultPath: '表格.csv', filters: [{ name: 'CSV 表格', extensions: ['csv'] }], properties: ['showOverwriteConfirmation'] }))
  ipcMain.handle(MARKDOWN_TABLE_EXPORT_CHANNEL, (event, request: unknown) => {
    try {
      assertTrustedRenderer(event)
      return tableExporter.export(BrowserWindow.fromWebContents(event.sender)!, request)
    } catch { return { status: 'failed', message: '无法从此窗口保存表格。' } }
  })
  ipcMain.handle(TEXT_ATTACHMENT_CHANNEL, async (event, command: unknown) => {
    assertTrustedRenderer(event)
    const parsed = attachmentCommandSchema.safeParse(command)
    if (!parsed.success) return { type: 'error', message: '无效的文本文件请求' }
    const request = parsed.data
    const owner = event.sender.id
    try {
      if (request.type === 'send' || request.type === 'query') {
        for (const [id, entry] of attachmentSubmissions)
          if (entry.receipt.status !== 'uncertain' && Date.now() - entry.at > 30 * 60 * 1000)
            attachmentSubmissions.delete(id)
        let entry = attachmentSubmissions.get(request.submissionId)
        if (
          entry &&
          (entry.owner !== owner || JSON.stringify(entry.scope) !== JSON.stringify(request.scope))
        )
          return {
            type: 'receipt',
            receipt: { submissionId: request.submissionId, status: 'rejected', code: 'stale' }
          }
        if (!entry && request.type === 'query')
          return {
            type: 'receipt',
            receipt: { submissionId: request.submissionId, status: 'uncertain', code: 'unknown' }
          }
        if (!entry) {
          if (
            [...attachmentSubmissions.values()].some(
              (e) =>
                e.owner === owner &&
                JSON.stringify(e.scope) === JSON.stringify(request.scope) &&
                e.receipt.status === 'uncertain'
            )
          )
            return {
              type: 'receipt',
              receipt: { submissionId: request.submissionId, status: 'rejected', code: 'busy' }
            }
          const files = textAttachments.capture(
            owner,
            request.scope,
            request.type === 'send' ? request.ids : []
          )
          const refusal = attachmentSubmissions.reserve(request.submissionId)
          if (refusal) return { type: 'receipt', receipt: refusal }
          entry = {
            owner,
            scope: request.scope,
            files,
            ids: files.map((f) => f.id),
            receipt: { submissionId: request.submissionId, status: 'uncertain', code: 'unknown' },
            at: Date.now()
          }
          attachmentSubmissions.set(request.submissionId, entry)
          const captured = entry
          entry.pending = callHost({
            type: 'attachment:prompt',
            scope: request.scope,
            submissionId: request.submissionId,
            text: formatTextContext(request.type === 'send' ? request.text : '', files)
          })
            .then((result) => {
              if (
                result.kind === 'attachment' &&
                result.receipt.submissionId === request.submissionId
              ) {
                captured.receipt = result.receipt
                captured.at = Date.now()
              }
              return captured.receipt
            })
            .catch(() => captured.receipt)
            .finally(() => {
              captured.pending = undefined
              attachmentSubmissions.prune()
            })
        } else if (
          request.type === 'query' &&
          !entry.pending &&
          entry.receipt.status === 'uncertain'
        ) {
          const result = await callHost({
            type: 'attachment:query',
            scope: request.scope,
            submissionId: request.submissionId
          }).catch(() => null)
          if (
            result?.kind === 'attachment' &&
            result.receipt.submissionId === request.submissionId
          ) {
            entry.receipt = result.receipt
            entry.at = Date.now()
          }
        }
        const receipt = entry.pending ? await entry.pending : entry.receipt
        if (receipt.status !== 'uncertain') {
          entry.files = []
          if (receipt.status === 'accepted')
            for (const id of entry.ids) {
              try {
                textAttachments.remove(owner, request.scope, id)
              } catch {
                /* Scope may have changed. */
              }
            }
        }
        return { type: 'receipt', receipt }
      }
      const check = textAttachments.lease(request.scope)
      if (request.type === 'remove') textAttachments.remove(owner, request.scope, request.id)
      if (request.type === 'pick') {
        const window = BrowserWindow.fromWebContents(event.sender)
        if (!window) throw new Error('窗口已关闭')
        const selected = await dialog.showOpenDialog(window, {
          title: '添加 UTF-8 文本文件',
          properties: ['openFile', 'multiSelections']
        })
        check()
        assertTrustedRenderer(event)
        if (!selected.canceled) await textAttachments.add(owner, request.scope, selected.filePaths)
      }
      if (request.type === 'file') {
        // Reuse the Files authority, including project identity and .git rejection.
        await workspaceFiles.dispatch({
          type: 'read',
          projectPath: request.scope.projectPath,
          path: request.path
        })
        check()
        assertTrustedRenderer(event)
        await textAttachments.add(owner, request.scope, [
          join(request.scope.projectPath, request.path)
        ])
      }
      check()
      assertTrustedRenderer(event)
      return { type: 'staged', files: textAttachments.list(owner, request.scope) }
    } catch (error) {
      if (request.type === 'send' && !attachmentSubmissions.has(request.submissionId))
        return {
          type: 'receipt',
          receipt: { submissionId: request.submissionId, status: 'rejected', code: 'stale' }
        }
      const message =
        error instanceof Error && !('code' in error) ? error.message : '无法添加文本文件，请重试'
      return { type: 'error', message }
    }
  })
  ipcMain.handle(TERMINAL_CHANNEL, (event, command: unknown) => {
    try {
      assertTrustedRenderer(event)
    } catch {
      return { type: 'unavailable', message: '拒绝非可信主窗口终端请求' }
    }
    return terminalManager.dispatch(event.sender.id, command)
  })
  ipcMain.handle(GIT_REVIEW_CHANNEL, async (event, command: unknown) => {
    assertTrustedRenderer(event)
    const parsed = gitReviewCommandSchema.safeParse(command)
    if (!parsed.success)
      return { type: 'unavailable', reason: 'invalid-request', message: '无效的 Git Review 请求' }
    if (!gitReview)
      return { type: 'unavailable', reason: 'git-unavailable', message: '可信 Git 服务不可用' }
    return gitReview.dispatch(parsed.data)
  })
  ipcMain.handle(WORKSPACE_FILES_CHANNEL, async (event, command: unknown) => {
    assertTrustedRenderer(event)
    const parsed = workspaceFilesCommandSchema.safeParse(command)
    if (!parsed.success) throw new Error('无效的工作区文件请求')
    return workspaceFiles.dispatch(parsed.data)
  })
  ipcMain.handle('pi:reconnect', async (event) => {
    assertTrustedRenderer(event)
    if (!reconnectingHost) {
      reconnectingHost = (async () => {
        if (!agentHost) startAgentHost()
        const target = recoveryTarget
        if (target?.project) await callHostSnapshot({ type: 'project:open', cwd: target.project })
        if (target?.session) await callHostSnapshot({ type: 'session:open', path: target.session })
        const snapshot = await callHostSnapshot({ type: 'state:get' })
        recoveryTarget = null
        return snapshot
      })().finally(() => {
        reconnectingHost = null
      })
    }
    return reconnectingHost
  })
  ipcMain.handle('pi:state', async (event) => {
    assertTrustedRenderer(event)
    return projectOpenCoordinator.restoreThenRead(attemptRecentProjectRestore, () =>
      callHostSnapshot({ type: 'state:get' })
    )
  })
  ipcMain.handle('pi:command', async (event, command: HostCommand) => {
    assertTrustedRenderer(event)
    const parsed = hostCommandSchema.safeParse(command)
    if (!parsed.success) throw new Error('无效的 Pi Desktop IPC 请求')
    if (parsed.data.type === 'attachment:prompt' || parsed.data.type === 'attachment:query')
      throw new Error('文本附件必须通过文件选择入口发送')
    if (parsed.data.type === 'project:open') {
      const snapshot = await openUserProject(parsed.data.cwd)
      return { kind: 'snapshot', snapshot } satisfies HostResult
    }
    if (parsed.data.type === 'project:catalog') {
      return callHost({...parsed.data,recentPaths:mergeRecentProjects(preferenceStore().get('recentProjects'),preferenceStore().get('lastProjectPath'))})
    }
    if (parsed.data.type === 'project:navigate') {
      const command = parsed.data
      return projectOpenCoordinator.runUserOpen(async () => {
        const cwd = await resolveExistingProjectPath(command.cwd)
        if (!cwd) throw new Error('所选项目目录不可用，请重试')
        const snapshot = await callHostSnapshot({...command,cwd})
        if (snapshot.project?.path === cwd) {
          preferenceStore().set('lastProjectPath',cwd)
          preferenceStore().set('recentProjects',mergeRecentProjects(preferenceStore().get('recentProjects'),cwd))
        }
        return snapshot
      }).then(snapshot => ({kind:'snapshot',snapshot} satisfies HostResult))
    }
    if (parsed.data.type === 'browser:e2e' && !E2E_MODE) {
      throw new Error('该 Agent Browser 测试命令只在 E2E 模式可用')
    }
    return callHost(parsed.data)
  })
  ipcMain.handle('pi:select-project', async (event) => {
    assertTrustedRenderer(event)
    const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          title: '选择 Pi 工作区',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: '选择 Pi 工作区',
          properties: ['openDirectory', 'createDirectory']
        })

    const cwd = result.filePaths[0]
    if (result.canceled || !cwd) return null
    return openUserProject(cwd)
  })
  ipcMain.handle('pi:browser', async (event, command: BrowserCommand) => {
    assertTrustedRenderer(event)
    const parsed = browserCommandSchema.safeParse(command)
    if (!parsed.success) throw new Error('无效的浏览器 IPC 请求')
    const manager = browserManager
    if (!manager) throw new Error('浏览器工作台尚未就绪')
    switch (parsed.data.type) {
      case 'state:get':
        return { state: manager.getState() }
      case 'operate': {
        const result = await manager.executeUser(parsed.data.operation)
        return { state: manager.getState(), result }
      }
      case 'agent:stop':
        manager.abortAgent()
        return { state: manager.getState() }
      case 'e2e:agent': {
        if (!E2E_MODE) throw new Error('该浏览器测试命令只在 E2E 模式可用')
        const result = await manager.executeAgent(parsed.data.operation, randomUUID())
        return { state: manager.getState(), result }
      }
    }
  })
  ipcMain.handle(WORKBENCH_CHANNEL, async (event, command: unknown) => {
    assertTrustedRenderer(event)
    const parsed = workbenchCommandSchema.safeParse(command)
    if (!parsed.success) throw new Error('无效的 Workbench IPC 请求')
    const host = workbenchHost
    if (!host) throw new Error('Workbench 尚未就绪')
    return host.dispatch(parsed.data)
  })
  ipcMain.handle(WORKBENCH_PANEL_CHANNEL, (event, command: unknown) =>
    workbenchPanelIpc.handle(event, command)
  )
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'Pi Desktop',
    backgroundColor: '#0A0A0A',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  browserOwner = mainWindow
  const registerTerminalWindow = (): void =>
    terminalManager.registerWindow(mainWindow.webContents.id, (event) => {
      if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
        mainWindow.webContents.send(TERMINAL_EVENT_CHANNEL, event)
    })
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) terminalManager.invalidateWindow(mainWindow.webContents.id)
  })
  mainWindow.webContents.on('render-process-gone', () =>
    terminalManager.invalidateWindow(mainWindow.webContents.id)
  )
  mainWindow.webContents.on('did-finish-load', registerTerminalWindow)
  let terminalCloseComplete = false
  mainWindow.on('close', (event) => {
    if (terminalCloseComplete || terminalQuitComplete) return
    event.preventDefault()
    void terminalManager.shutdown().finally(() => {
      terminalCloseComplete = true
      if (!mainWindow.isDestroyed()) mainWindow.close()
    })
  })
  browserManager = new BrowserManager(mainWindow, (state) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pi:browser:event', { type: 'state', data: state })
    }
  })
  const workbenchStore: WorkbenchStateStore = {
    get: (key) => preferenceStore().get(key as keyof Preferences),
    set: (key, value) => {
      preferenceStore().set(key as keyof Preferences, value)
    }
  }
  workbenchHost = createWorkbenchHost({
    appVersion: app.getVersion(),
    agentDir: e2eAgentDir ?? join(homedir(), '.pi', 'agent'),
    preloadPath: join(__dirname, '../preload/plugin.js'),
    store: workbenchStore,
    window: mainWindow,
    browser: browserManager,
    panelSenderBinding: workbenchPanelIpc,
    onState: (state) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(WORKBENCH_EVENT_CHANNEL, {
          type: 'state',
          data: state
        } satisfies WorkbenchEvent)
      }
    }
  })
  updateWorkbenchContext()
  void workbenchHost.reload().catch((error) => {
    console.error('无法加载 Workbench 插件', errorMessage(error))
  })
  packageRootsLifecycle.attachHost(workbenchHost)

  mainWindow.on('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url)
      if (target.protocol === 'https:' || target.protocol === 'http:') {
        void shell.openExternal(target.toString())
      }
    } catch (error) {
      console.warn('拒绝打开无效链接', errorMessage(error))
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow.webContents.getURL()
    if (current && url === current) return
    event.preventDefault()
  })
  const attachmentOwner = mainWindow.webContents.id
  mainWindow.webContents.on('destroyed', () => {
    textAttachments.clearOwner(attachmentOwner)
    for (const [id, entry] of attachmentSubmissions)
      if (entry.owner === attachmentOwner) attachmentSubmissions.delete(id)
  })
  mainWindow.on('closed', () => {
    if (browserOwner !== mainWindow) return
    const host = workbenchHost
    if (host) packageRootsLifecycle.detachHost(host)
    host?.dispose()
    workbenchHost = null
    browserManager?.dispose()
    browserManager = null
    browserOwner = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('works.pi.desktop')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  try {
    const sessionData = app.getPath('sessionData')
    await mkdir(sessionData, { recursive: true })
    const hooksPath = await mkdtemp(join(sessionData, 'git-review-hooks-'))
    gitReview = new GitReview({
      gitPath: '/usr/bin/git',
      hooksPath,
      trustedEnv: {
        HOME: homedir(),
        PATH: '/usr/bin:/bin',
        TMPDIR: app.getPath('temp'),
        LC_ALL: 'C'
      }
    })
    gitReview.setProject(activeProjectPath)
  } catch {
    console.warn('Git Review 初始化失败')
  }

  const Store = await loadElectronStoreConstructor()
  preferences = new Store<Preferences>({
    name: 'pi-desktop-preferences',
    schema: {
      lastProjectPath: { type: 'string' },
      recentProjects: { type: 'array', items: {type:'string'}, maxItems:100 },
      workbenchDesktopEnabled: {
        type: 'object',
        additionalProperties: { type: 'boolean' }
      },
      workbenchPanelState: { type: 'object' }
    }
  })

  registerIpc()
  startAgentHost()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let terminalQuitComplete = false
app.on('before-quit', (event) => {
  if (!terminalQuitComplete) {
    event.preventDefault()
    void terminalManager.shutdown().finally(() => {
      terminalQuitComplete = true
      app.quit()
    })
    return
  }
  gitReview?.setProject(null)
  const host = workbenchHost
  if (host) packageRootsLifecycle.detachHost(host)
  host?.dispose()
  workbenchHost = null
  browserManager?.dispose()
  browserManager = null
  agentHost?.kill()
  agentHost = null
})
