import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { PiPackageRoot } from '../shared/workbench-host-contracts'
import type { PluginInstallPreview, PluginInstallSource } from '../shared/plugin-install'
import { t } from '../shared/i18n'
import type { WorkbenchManifestDiscovery } from './workbench-manifest'
import { NULL_DEVICE, systemGit, type SystemGit } from './system-git'
import { extractZip } from './zip-extract'

/** Where an installed plugin came from, so it can be updated from the same place. */
export type PluginInstallRecord = {
  source: PluginInstallSource
  version: string
  installedAt: number
}

export type PluginInstallerOptions = {
  /** `desktop-plugins`: one directory per installed plugin. */
  pluginsDirectory: string
  /** Scratch space next to it, so the final move is a rename on the same disk. */
  stagingDirectory: string
  appVersion: string
  discover(options: {
    roots: readonly PiPackageRoot[]
    appVersion: string
  }): Promise<WorkbenchManifestDiscovery>
  /** Ids of plugins that ship with the app; an install may not replace them. */
  bundledIds(): Promise<ReadonlySet<string>>
  records: {
    get(): Record<string, PluginInstallRecord>
    set(records: Record<string, PluginInstallRecord>): void
  }
  git?: SystemGit
  now?: () => number
}

type Staged = { directory: string; root: string; preview: PluginInstallPreview }

/** Largest plugin copied from a folder; archives have their own limit. */
const MAX_FOLDER_ENTRIES = 5_000

/**
 * Installs user plugins into `desktop-plugins`. Nothing reaches that directory until the
 * user has seen what the plugin is and what it asks for: a source is first copied into a
 * staging directory and validated like any discovered plugin, and only confirming moves it
 * into place, replacing an older version of the same plugin in one rename.
 */
export class PluginInstaller {
  private readonly staged = new Map<string, Staged>()

  constructor(private readonly options: PluginInstallerOptions) {}

  async inspect(source: PluginInstallSource): Promise<PluginInstallPreview> {
    const stagingId = randomUUID()
    const directory = join(this.options.stagingDirectory, stagingId)
    await mkdir(directory, { recursive: true })
    try {
      const content = join(directory, 'content')
      await mkdir(content)
      if (source.kind === 'folder') await copyFolder(source.path, content)
      else if (source.kind === 'zip') await extractZip(source.path, content)
      else await this.clone(source.url, content)
      const root = await pluginRoot(content)
      const discovery = await this.options.discover({
        roots: [
          { path: root, source: t('待安装'), scope: 'user', hasExecutablePiResources: false }
        ],
        appVersion: this.options.appVersion
      })
      const plugin = discovery.plugins[0]
      if (!plugin) {
        const reason = discovery.diagnostics.map((diagnostic) => diagnostic.message).join(' ')
        throw new Error(t('这不是可用的 Pi Desktop 插件：{reason}', { reason }))
      }
      if ((await this.options.bundledIds()).has(plugin.pluginId))
        throw new Error(t('插件 {id} 与内置插件同名，不能安装', { id: plugin.pluginId }))
      const existing = this.options.records.get()[plugin.pluginId]
      const preview: PluginInstallPreview = {
        stagingId,
        pluginId: plugin.pluginId,
        name: plugin.name,
        version: plugin.version,
        ...(plugin.description ? { description: plugin.description } : {}),
        permissions: [...plugin.requestedPermissions],
        runsCode: plugin.canonicalMainPath !== undefined,
        existingVersion: existing?.version ?? null,
        source,
        verified: false
      }
      this.staged.set(stagingId, { directory, root, preview })
      return preview
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  /** Moves a reviewed plugin into place and returns its id. */
  async confirm(stagingId: string): Promise<string> {
    const staged = this.staged.get(stagingId)
    if (!staged) throw new Error(t('安装已过期，请重新选择插件'))
    this.staged.delete(stagingId)
    const { pluginId, version, source } = staged.preview
    const target = join(this.options.pluginsDirectory, pluginId)
    const previous = join(this.options.stagingDirectory, `${stagingId}-previous`)
    await mkdir(this.options.pluginsDirectory, { recursive: true })
    let replaced = false
    try {
      // Another directory that already holds this plugin (copied in by hand) gives way too.
      for (const other of await this.directoriesOf(pluginId))
        if (other !== target) await rm(other, { recursive: true, force: true })
      if (await exists(target)) {
        await rename(target, previous)
        replaced = true
      }
      await rename(staged.root, target)
    } catch (error) {
      if (replaced && !(await exists(target))) await rename(previous, target).catch(() => undefined)
      throw error
    } finally {
      await rm(previous, { recursive: true, force: true })
      await rm(staged.directory, { recursive: true, force: true })
    }
    this.options.records.set({
      ...this.options.records.get(),
      [pluginId]: { source, version, installedAt: this.options.now?.() ?? Date.now() }
    })
    return pluginId
  }

  async cancel(stagingId: string): Promise<void> {
    const staged = this.staged.get(stagingId)
    this.staged.delete(stagingId)
    if (staged) await rm(staged.directory, { recursive: true, force: true })
  }

  /** Stages the newest version from where the plugin was installed. */
  async update(pluginId: string): Promise<PluginInstallPreview> {
    const record = this.options.records.get()[pluginId]
    if (!record) throw new Error(t('这个插件不是从应用里安装的，无法自动更新'))
    const preview = await this.inspect(record.source)
    if (preview.pluginId !== pluginId) {
      await this.cancel(preview.stagingId)
      throw new Error(t('来源现在提供的是另一个插件（{id}）', { id: preview.pluginId }))
    }
    return preview
  }

  async uninstall(pluginId: string): Promise<void> {
    const directories = await this.directoriesOf(pluginId)
    if (!directories.length) throw new Error(t('只能卸载你安装的插件'))
    for (const directory of directories) await rm(directory, { recursive: true, force: true })
    const rest = { ...this.options.records.get() }
    delete rest[pluginId]
    this.options.records.set(rest)
  }

  /** Removes staging left behind by a crash or a cancelled review. */
  async clearStaging(): Promise<void> {
    this.staged.clear()
    await rm(this.options.stagingDirectory, { recursive: true, force: true })
  }

  /** Every directory under `desktop-plugins` whose manifest declares this id. */
  private async directoriesOf(pluginId: string): Promise<string[]> {
    let children
    try {
      children = await readdir(this.options.pluginsDirectory, { withFileTypes: true })
    } catch {
      return []
    }
    const roots = children
      .filter((child) => child.isDirectory())
      .map((child) => join(this.options.pluginsDirectory, child.name))
    const found: string[] = []
    for (const path of roots) {
      const discovery = await this.options.discover({
        roots: [{ path, source: '', scope: 'user', hasExecutablePiResources: false }],
        appVersion: this.options.appVersion
      })
      if (discovery.plugins[0]?.pluginId === pluginId) found.push(path)
      // A plugin this version no longer accepts still counts by its directory name.
      else if (!discovery.plugins.length && path === join(this.options.pluginsDirectory, pluginId))
        found.push(path)
    }
    return found
  }

  private clone(url: string, target: string): Promise<void> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(t('Git 地址无效'))
    }
    // Other transports (ext::, file://, ssh) can run commands or read local files.
    if (parsed.protocol !== 'https:') throw new Error(t('只支持 https:// 开头的 Git 地址'))
    const git = this.options.git ?? systemGit()
    return new Promise((resolve, reject) => {
      execFile(
        git.path,
        [
          '-c',
          'protocol.allow=never',
          '-c',
          'protocol.https.allow=always',
          'clone',
          '--depth',
          '1',
          '--no-recurse-submodules',
          '--',
          parsed.toString(),
          target
        ],
        {
          env: {
            ...git.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_CONFIG_GLOBAL: NULL_DEVICE,
            GIT_CONFIG_NOSYSTEM: '1',
            ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {})
          },
          timeout: 120_000,
          maxBuffer: 1024 * 1024
        },
        (error, _stdout, stderr) => {
          if (error)
            reject(
              new Error(t('无法下载插件：{reason}', { reason: lastLine(stderr) || error.message }))
            )
          else
            rm(join(target, '.git'), { recursive: true, force: true }).then(() => resolve(), reject)
        }
      )
    })
  }
}

/** The manifest's directory: the top level, or the single folder an archive wraps it in. */
async function pluginRoot(content: string): Promise<string> {
  const manifests = ['pi-desktop.json', 'manifest.json']
  const has = async (directory: string): Promise<boolean> => {
    for (const name of manifests) if (await exists(join(directory, name))) return true
    return false
  }
  if (await has(content)) return content
  const children = (await readdir(content, { withFileTypes: true })).filter(
    (child) => !child.name.startsWith('.') && child.name !== '__MACOSX'
  )
  if (children.length === 1 && children[0]!.isDirectory()) {
    const inner = join(content, children[0]!.name)
    if (await has(inner)) return inner
  }
  throw new Error(t('没有找到 pi-desktop.json 或 manifest.json'))
}

/** Copies a plugin folder; links are refused so nothing outside it comes along. */
async function copyFolder(source: string, target: string): Promise<void> {
  const info = await stat(source).catch(() => null)
  if (!info?.isDirectory()) throw new Error(t('所选路径不是文件夹'))
  let entries = 0
  await cp(source, target, {
    recursive: true,
    errorOnExist: true,
    filter: async (path) => {
      if (++entries > MAX_FOLDER_ENTRIES) throw new Error(t('插件文件夹里的文件太多'))
      const name = path.slice(source.length).replace(/^[\\/]+/, '')
      if (name.split(/[\\/]/).some((part) => part === '.git')) return false
      if ((await lstat(path)).isSymbolicLink())
        throw new Error(t('插件文件夹里不能有符号链接：{name}', { name }))
      return true
    }
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1)?.trim() ?? ''
}
