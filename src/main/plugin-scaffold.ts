import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import semver from 'semver'
import type { PluginTemplate } from '../shared/plugin-install'
import { t } from '../shared/i18n'

export type ScaffoldOptions = {
  /** `resources/plugin-sdk`: templates, types and the manifest schema. */
  sdkDirectory: string
  parentPath: string
  template: PluginTemplate
  id: string
  name: string
  appVersion: string
}

/**
 * Writes a new plugin from a template: the template's files with its id, name and the
 * current Pi Desktop version filled in, plus `types/` and `jsconfig.json` so an editor
 * checks the code against the plugin API with no build step. Returns the new folder.
 * Files are read and written one by one so this also works from inside the app's asar.
 */
export async function scaffoldPlugin(options: ScaffoldOptions): Promise<string> {
  const folderName = options.id.split('.').at(-1)!
  const target = join(options.parentPath, folderName)
  if (await stat(target).catch(() => null))
    throw new Error(t('文件夹 {path} 已存在', { path: target }))
  const release = semver.parse(options.appVersion)
  const values: Record<string, string> = {
    __PLUGIN_ID__: options.id,
    // The command schema keeps quotes, backslashes and markup out of the name, so it can
    // be placed in JSON strings and HTML text as it is.
    __PLUGIN_NAME__: options.name,
    __ENGINE__: release ? `>=${release.major}.${release.minor}.0` : '>=0.1.0'
  }
  const files: [string, string][] = [
    ...(await readTree(join(options.sdkDirectory, 'templates', options.template))),
    ['jsconfig.json', await readFile(join(options.sdkDirectory, 'jsconfig.json'), 'utf8')],
    [
      'types/pi-desktop.d.ts',
      await readFile(join(options.sdkDirectory, 'pi-desktop.d.ts'), 'utf8')
    ],
    [
      'types/pi-desktop.schema.json',
      await readFile(join(options.sdkDirectory, 'pi-desktop.schema.json'), 'utf8')
    ]
  ]
  await mkdir(target, { recursive: true })
  try {
    for (const [path, text] of files) {
      const file = join(target, ...path.split('/'))
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(
        file,
        text.replace(/__PLUGIN_ID__|__PLUGIN_NAME__|__ENGINE__/g, (key) => values[key]!),
        { flag: 'wx' }
      )
    }
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
  return target
}

/** Every file under a directory as `[relative path, text]`. */
async function readTree(root: string, prefix = ''): Promise<[string, string][]> {
  const files: [string, string][] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...(await readTree(root, path)))
    else if (entry.isFile()) files.push([path, await readFile(join(root, path), 'utf8')])
  }
  return files
}
