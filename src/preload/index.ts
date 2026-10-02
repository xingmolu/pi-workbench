import { agentSnapshotSchema } from '../shared/schemas'
import { agentRuntimeCatalogSchema, RUNTIME_CATALOG_CHANNEL } from '../shared/agent-runtime'
import { NAVIGATION_LIBRARY_CHANNEL, navigationLibraryCommandSchema, navigationLibrarySchema } from '../shared/navigation-library'
import { contextBridge, ipcRenderer } from 'electron'
import { SessionOriginTracker } from './session-origin'
import {
  desktopCommandOriginSchema,
  liveSessionSummarySchema,
  type DesktopCommandOrigin
} from '../shared/session-runtime'
import {
  NATIVE_PALETTE_FOCUS_CHANNEL,
  nativePaletteFocusSchema
} from '../shared/native-palette-focus'
import {
  DESKTOP_SETTINGS_CHANNEL,
  desktopSettingsCommandSchema,
  desktopSettingsSchema
} from '../shared/desktop-settings'
import { DESKTOP_CONTROL_CHANNEL } from '../shared/desktop-control'
import { APP_UPDATE_CHANNEL, APP_UPDATE_EVENT_CHANNEL, type AppUpdateStatus } from '../shared/app-updates'
import { createDesktopControlClient } from './desktop-control-client'
import {
  MOBILE_GATEWAY_CHANNEL,
  mobileGatewayCommandSchema,
  mobileGatewayStateSchema
} from '../shared/mobile-gateway'
import {
  MARKDOWN_TABLE_EXPORT_CHANNEL,
  validateMarkdownTable
} from '../shared/markdown-table-export'
import type {
  AgentSnapshot,
  BrowserCommand,
  BrowserCommandResult,
  BrowserEvent,
  HostCommand,
  DesktopEvent,
  HostResultFor,
  PiDesktopAPI
} from '../shared/contracts'
import { WORKBENCH_CHANNEL, WORKBENCH_EVENT_CHANNEL } from '../shared/workbench-contracts'
import { createBrowserEventSubscriber } from './browser-event-client'
import { createWorkbenchClient } from './workbench-client'
import { WORKSPACE_FILES_CHANNEL } from '../shared/workspace-files'
import { TEXT_ATTACHMENT_CHANNEL, attachmentCommandSchema } from '../shared/text-attachments'
import { GIT_REVIEW_CHANNEL } from '../shared/git-review'
import {
  TERMINAL_CHANNEL,
  TERMINAL_EVENT_CHANNEL,
  terminalCommandSchema,
  terminalEventSchema
} from '../shared/terminal'

const desktopControlClient = createDesktopControlClient({
  invoke: (command) => ipcRenderer.invoke(DESKTOP_CONTROL_CHANNEL, command)
})

const workbenchClient = createWorkbenchClient({
  invoke: (command) => ipcRenderer.invoke(WORKBENCH_CHANNEL, command),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => listener(value)
    ipcRenderer.on(WORKBENCH_EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(WORKBENCH_EVENT_CHANNEL, handler)
  }
})

const subscribeToBrowserEvent = createBrowserEventSubscriber({
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => listener(value)
    ipcRenderer.on('pi:browser:event', handler)
    return () => ipcRenderer.removeListener('pi:browser:event', handler)
  }
})

const origins = new SessionOriginTracker()
ipcRenderer.on('pi:event', (_event, value: DesktopEvent) => {
  if (value.event === 'snapshot') origins.accept(value.data)
  if (value.event === 'patch')
    origins.accept({ ...value.data, desktopScope: value.data.meta.desktopScope, desktopEpoch: value.data.meta.desktopEpoch })
})
const originFor = (origin?: DesktopCommandOrigin): DesktopCommandOrigin | undefined => {
  const captured = origin ?? origins.capture()
  return captured && desktopCommandOriginSchema.parse(captured)
}
const acceptSnapshot = (snapshot: AgentSnapshot): AgentSnapshot => {
  origins.accept(snapshot)
  return snapshot
}

const api: PiDesktopAPI = {
  navigationLibrary: async (command) => navigationLibrarySchema.parse(
    await ipcRenderer.invoke(NAVIGATION_LIBRARY_CHANNEL, navigationLibraryCommandSchema.parse(command))
  ),
  nativePaletteFocus: (command) =>
    ipcRenderer.invoke(NATIVE_PALETTE_FOCUS_CHANNEL, nativePaletteFocusSchema.parse(command)),
  desktopSettings: async (command) =>
    desktopSettingsSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_SETTINGS_CHANNEL,
        desktopSettingsCommandSchema.parse(command)
      )
    ),
  mobileGateway: async (command) =>
    mobileGatewayStateSchema.parse(
      await ipcRenderer.invoke(
        MOBILE_GATEWAY_CHANNEL,
        mobileGatewayCommandSchema.parse(command)
      )
    ),
  exportMarkdownTable: (request) =>
    ipcRenderer.invoke(MARKDOWN_TABLE_EXPORT_CHANNEL, validateMarkdownTable(request)),
  textAttachments: (command) =>
    ipcRenderer.invoke(TEXT_ATTACHMENT_CHANNEL, attachmentCommandSchema.parse(command)),
  terminal: (command) => ipcRenderer.invoke(TERMINAL_CHANNEL, terminalCommandSchema.parse(command)),
  appUpdate: (command) => ipcRenderer.invoke(APP_UPDATE_CHANNEL, command),
  onAppUpdate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void =>
      listener(value as AppUpdateStatus)
    ipcRenderer.on(APP_UPDATE_EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(APP_UPDATE_EVENT_CHANNEL, handler)
  },
  onTerminalEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      const parsed = terminalEventSchema.safeParse(value)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(TERMINAL_EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(TERMINAL_EVENT_CHANNEL, handler)
  },
  gitReview: (command) => ipcRenderer.invoke(GIT_REVIEW_CHANNEL, command),
  workspaceFiles: (command) => ipcRenderer.invoke(WORKSPACE_FILES_CHANNEL, command),
  desktopControl: (command) => desktopControlClient.desktopControl(command),
  getState: async (): Promise<AgentSnapshot> =>
    acceptSnapshot(await ipcRenderer.invoke('pi:state')),
  legacyPiHistory: () => ipcRenderer.invoke('pi:legacy-history'),
  importPiHistory: () => ipcRenderer.invoke('pi:import-history'),
  selectRuntime: async (runtimeId, origin) => agentSnapshotSchema.parse(await ipcRenderer.invoke('pi:runtime-select', runtimeId, origin)),
  runtimeAccounts: () => ipcRenderer.invoke('pi:runtime-accounts'),
  engineBinary: (runtimeId, action) => ipcRenderer.invoke('pi:engine-binary', runtimeId, action),
  respondCredentialGrant: (id, decision) =>
    ipcRenderer.invoke('pi:credential-grant:respond', id, decision),
  credentialGrants: () => ipcRenderer.invoke('pi:credential-grants'),
  revokeCredentialGrant: (runtimeId, account) =>
    ipcRenderer.invoke('pi:credential-grant:revoke', runtimeId, account),
  runtimeConfig: (runtimeId, command) =>
    ipcRenderer.invoke('pi:runtime-config', runtimeId, command),
  defaultRuntime: () => ipcRenderer.invoke('pi:default-runtime'),
  setDefaultRuntime: async (runtimeId) => {
    await ipcRenderer.invoke('pi:default-runtime:set', runtimeId)
  },
  listRuntimes: async () => agentRuntimeCatalogSchema.parse(await ipcRenderer.invoke(RUNTIME_CATALOG_CHANNEL)),
  reconnect: async (): Promise<AgentSnapshot> =>
    acceptSnapshot(await ipcRenderer.invoke('pi:reconnect')),
  selectProject: async (origin): Promise<AgentSnapshot | null> => {
    const snapshot = await ipcRenderer.invoke('pi:select-project', originFor(origin))
    return snapshot ? acceptSnapshot(snapshot) : null
  },
  inspectSubagent: async (taskId, origin) => agentSnapshotSchema.parse(await ipcRenderer.invoke('pi:subagent-inspect', taskId, desktopCommandOriginSchema.parse(origin))),
  selectSession: async (workerId, origin) =>
    acceptSnapshot(await ipcRenderer.invoke('pi:session-select', workerId, originFor(origin))),
  send: async <Command extends HostCommand>(
    command: Command,
    origin?: DesktopCommandOrigin
  ): Promise<HostResultFor<Command>> => {
    const result: HostResultFor<Command> = await ipcRenderer.invoke(
      'pi:command',
      command,
      originFor(origin)
    )
    if (result.kind === 'snapshot' || result.kind === 'session-fork')
      acceptSnapshot(result.snapshot)
    return result
  },
  onEvent: (listener: (event: DesktopEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: DesktopEvent): void => {
      if (value.event === 'sessions') {
        const parsed = liveSessionSummarySchema.array().max(8).safeParse(value.data)
        if (parsed.success) listener({ ...value, data: parsed.data })
      } else if (value.event === 'navigation-library') {
        const parsed = navigationLibrarySchema.safeParse(value.data)
        if (parsed.success) listener({ ...value, data: parsed.data })
      } else if (value.event === 'mobile-gateway') {
        const parsed = mobileGatewayStateSchema.safeParse(value.data)
        if (parsed.success) listener({ ...value, data: parsed.data })
      } else listener(value)
    }
    ipcRenderer.on('pi:event', handler)
    return () => ipcRenderer.removeListener('pi:event', handler)
  },
  browser: (command: BrowserCommand): Promise<BrowserCommandResult> =>
    ipcRenderer.invoke('pi:browser', command),
  onBrowserEvent: (listener: (event: BrowserEvent) => void): (() => void) =>
    subscribeToBrowserEvent(listener),
  ...workbenchClient
}

contextBridge.exposeInMainWorld('pi', api)
