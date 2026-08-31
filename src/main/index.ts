import { app, shell, BrowserWindow, ipcMain, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

/**
 * Pi Desktop process model:
 *   Renderer  — React UI, no Node, no Pi import
 *   Main      — window / tray / WebContentsView / pty
 *   Agent Host — this utilityProcess. Engine will be
 *                `@earendil-works/pi-coding-agent` via
 *                createAgentSession({ agentDir: ~/.pi/agent })
 *
 * Do not load DSH Web UI. Do not fork dsh-desktop.
 */

export type AgentHostStatus = {
  ready: boolean
  stub: boolean
  engine: string
  agentDir: string
}

const DEFAULT_AGENT_DIR = join(homedir(), '.pi', 'agent')

let agentHost: UtilityProcess | null = null
let agentHostStatus: AgentHostStatus = {
  ready: false,
  stub: true,
  engine: '@earendil-works/pi-coding-agent',
  agentDir: DEFAULT_AGENT_DIR
}

function startAgentHost(): void {
  const script = join(__dirname, 'agent-host.js')
  agentHost = utilityProcess.fork(script, [], {
    serviceName: 'Pi Agent Host',
    stdio: 'pipe'
  })

  agentHost.on('spawn', () => {
    agentHost?.postMessage({ type: 'bootstrap' })
  })

  agentHost.on('message', (message: unknown) => {
    const msg = message as { type?: string; agentDir?: string; engine?: string; stub?: boolean }
    if (msg?.type === 'ready') {
      agentHostStatus = {
        ready: true,
        stub: msg.stub !== false,
        engine: msg.engine ?? '@earendil-works/pi-coding-agent',
        agentDir: msg.agentDir ?? DEFAULT_AGENT_DIR
      }
    }
  })

  agentHost.on('exit', (code) => {
    if (code !== 0) {
      agentHostStatus = { ...agentHostStatus, ready: false }
    }
    agentHost = null
  })
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
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('works.pi.desktop')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('agent-host:status', () => agentHostStatus)

  startAgentHost()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  agentHost?.kill()
  agentHost = null
})
