import { useCallback, useEffect, useState } from 'react'
import type {
  PluginDevelopmentFolder,
  PluginInstallPreview,
  PluginInstallSource,
  PluginTemplate
} from '../../../shared/plugin-install'
import { t } from '../../../shared/i18n'

type Installed = Record<string, { source: PluginInstallSource; version: string }>

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // Electron prefixes errors from the main process with where they came from.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function sourceText(source: PluginInstallSource): string {
  return source.kind === 'git' ? source.url : source.path
}

/** Installing, updating and removing plugins; one action at a time. */
export type PluginInstall = {
  installed: Installed
  /** Folders loaded for development, and what each holds. */
  development: PluginDevelopmentFolder[]
  preview: PluginInstallPreview | null
  busy: boolean
  error: string | null
  inspect(source: PluginInstallSource): Promise<void>
  pick(kind: 'folder' | 'zip'): Promise<void>
  update(pluginId: string): Promise<void>
  uninstall(pluginId: string, name: string): Promise<void>
  confirm(): Promise<void>
  cancel(): Promise<void>
  refresh(): Promise<void>
  /** Picks a folder and loads the plugin in it for development. */
  develop(): Promise<void>
  undevelop(path: string): Promise<void>
  reload(pluginId: string): Promise<void>
  /** Picks where to put a new plugin, writes it from a template and develops it. */
  scaffold(request: { template: PluginTemplate; id: string; name: string }): Promise<boolean>
}

export function usePluginInstall(): PluginInstall {
  const [installed, setInstalled] = useState<Installed>({})
  const [development, setDevelopment] = useState<PluginDevelopmentFolder[]>([])
  const [preview, setPreview] = useState<PluginInstallPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const result = await window.pi.pluginInstall({ type: 'list' })
    if (result.type !== 'installed') return
    setInstalled(result.plugins)
    setDevelopment(result.development)
  }, [])
  const quietRefresh = useCallback(() => refresh().catch(() => undefined), [refresh])
  useEffect(() => {
    void quietRefresh()
  }, [quietRefresh])

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  const showPreview = async (
    request: Promise<Awaited<ReturnType<typeof window.pi.pluginInstall>>>
  ): Promise<void> => {
    const result = await request
    if (result.type === 'preview') setPreview(result.preview)
  }

  return {
    installed,
    development,
    preview,
    busy,
    error,
    inspect: (source) =>
      run(() => showPreview(window.pi.pluginInstall({ type: 'inspect', source }))),
    pick: (kind) =>
      run(async () => {
        const picked = await window.pi.pluginInstall({ type: 'pick', kind })
        if (picked.type !== 'picked' || !picked.path) return
        await showPreview(
          window.pi.pluginInstall({ type: 'inspect', source: { kind, path: picked.path } })
        )
      }),
    update: (pluginId) =>
      run(() => showPreview(window.pi.pluginInstall({ type: 'update', pluginId }))),
    uninstall: (pluginId, name) =>
      run(async () => {
        if (!window.confirm(t('卸载 {name}？插件文件会被删除，它保存的设置会保留。', { name })))
          return
        await window.pi.pluginInstall({ type: 'uninstall', pluginId })
        await refresh()
      }),
    confirm: () =>
      run(async () => {
        if (!preview) return
        await window.pi.pluginInstall({ type: 'confirm', stagingId: preview.stagingId })
        setPreview(null)
        await refresh()
      }),
    cancel: () =>
      run(async () => {
        if (!preview) return
        await window.pi.pluginInstall({ type: 'cancel', stagingId: preview.stagingId })
        setPreview(null)
      }),
    refresh: quietRefresh,
    develop: () =>
      run(async () => {
        const picked = await window.pi.pluginInstall({ type: 'pick', kind: 'folder' })
        if (picked.type !== 'picked' || !picked.path) return
        await window.pi.pluginInstall({ type: 'develop', path: picked.path })
        await refresh()
      }),
    undevelop: (path) =>
      run(async () => {
        await window.pi.pluginInstall({ type: 'undevelop', path })
        await refresh()
      }),
    reload: (pluginId) =>
      run(async () => {
        await window.pi.pluginInstall({ type: 'reload', pluginId })
        await refresh()
      }),
    scaffold: async (request) => {
      let created = false
      await run(async () => {
        const picked = await window.pi.pluginInstall({ type: 'pick', kind: 'parent' })
        if (picked.type !== 'picked' || !picked.path) return
        await window.pi.pluginInstall({ type: 'scaffold', ...request, parentPath: picked.path })
        created = true
        await refresh()
      })
      return created
    }
  }
}
