import { useCallback, useEffect, useState } from 'react'
import type { PluginInstallPreview, PluginInstallSource } from '../../../shared/plugin-install'
import { t } from '../../../shared/i18n'

type Installed = Record<string, { source: PluginInstallSource; version: string }>

function errorText(error: unknown): string {
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
  preview: PluginInstallPreview | null
  busy: boolean
  error: string | null
  inspect(source: PluginInstallSource): Promise<void>
  pick(kind: 'folder' | 'zip'): Promise<void>
  update(pluginId: string): Promise<void>
  uninstall(pluginId: string, name: string): Promise<void>
  confirm(): Promise<void>
  cancel(): Promise<void>
}

export function usePluginInstall(): PluginInstall {
  const [installed, setInstalled] = useState<Installed>({})
  const [preview, setPreview] = useState<PluginInstallPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const result = await window.pi.pluginInstall({ type: 'list' })
    if (result.type === 'installed') setInstalled(result.plugins)
  }, [])
  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])

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
      })
  }
}
