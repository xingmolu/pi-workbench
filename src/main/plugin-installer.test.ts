import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginInstaller, type PluginInstallRecord } from './plugin-installer'
import { discoverWorkbenchManifests } from './workbench-manifest'
import { extractZip, safeRelativePath } from './zip-extract'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-plugin-install-'))
  roots.push(root)
  return root
}

/** A zip of the given files; `link` marks an entry as a Unix symbolic link. */
function zip(files: { name: string; data?: string; link?: boolean; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const raw = Buffer.from(file.data ?? '')
    const body = file.deflate ? deflateRawSync(raw) : raw
    const name = Buffer.from(file.name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(file.deflate ? 8 : 0, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(file.deflate ? 8 : 0, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((file.link ? 0o120777 : 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const manifest = (id: string, version: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schemaVersion: 1,
    id,
    version,
    name: 'Acme Notes',
    description: 'A notes panel',
    engines: { piDesktop: '>=0.1.0' },
    permissions: ['ui.view', 'storage'],
    contributes: {
      views: [{ id: 'notes', title: 'Notes', icon: 'plugin', entry: 'views/index.html' }]
    },
    ...extra
  })

async function pluginFolder(parent: string, id: string, version: string): Promise<string> {
  const folder = join(parent, `${id}-${version}`)
  await mkdir(join(folder, 'views'), { recursive: true })
  await writeFile(join(folder, 'pi-desktop.json'), manifest(id, version))
  await writeFile(join(folder, 'views', 'index.html'), `<p>${version}</p>`)
  return folder
}

async function installer(
  root: string,
  bundled: string[] = []
): Promise<{
  plugins: string
  records: () => Record<string, PluginInstallRecord>
  installer: PluginInstaller
}> {
  let records: Record<string, PluginInstallRecord> = {}
  const plugins = join(root, 'desktop-plugins')
  return {
    plugins,
    records: () => records,
    installer: new PluginInstaller({
      pluginsDirectory: plugins,
      stagingDirectory: join(root, 'plugin-staging'),
      appVersion: '0.1.0',
      discover: discoverWorkbenchManifests,
      bundledIds: async () => new Set(bundled),
      records: { get: () => records, set: (next) => (records = next) },
      now: () => 1000
    })
  }
}

describe('zip extraction', () => {
  it('writes stored and deflated files and refuses paths that leave the target', async () => {
    const root = await temp()
    const archive = join(root, 'a.zip')
    await writeFile(
      archive,
      zip([
        { name: 'plugin/' },
        { name: 'plugin/a.txt', data: 'stored' },
        { name: 'plugin/b.txt', data: 'deflated '.repeat(50), deflate: true }
      ])
    )
    await extractZip(archive, join(root, 'out'))
    expect(await readFile(join(root, 'out/plugin/a.txt'), 'utf8')).toBe('stored')
    expect(await readFile(join(root, 'out/plugin/b.txt'), 'utf8')).toBe('deflated '.repeat(50))

    for (const name of ['../evil.txt', '/etc/evil', 'C:/evil', 'a/../../evil'])
      expect(() => safeRelativePath(name)).toThrow()
    await writeFile(
      archive,
      zip([
        { name: 'ok.txt', data: 'x' },
        { name: '../evil.txt', data: 'x' }
      ])
    )
    await expect(extractZip(archive, join(root, 'escape'))).rejects.toThrow()
    // Nothing at all is written when one entry is unsafe.
    await expect(readdir(join(root, 'escape'))).rejects.toThrow()
    await writeFile(archive, zip([{ name: 'link', data: '/etc/passwd', link: true }]))
    await expect(extractZip(archive, join(root, 'link'))).rejects.toThrow()
    await writeFile(archive, zip([{ name: 'big.txt', data: 'x'.repeat(100) }]))
    await expect(
      extractZip(archive, join(root, 'big'), { maxEntries: 10, maxTotalBytes: 10 })
    ).rejects.toThrow()
  })
})

describe('plugin installer', () => {
  it('installs from a folder only after review, and replaces it with a newer version', async () => {
    const root = await temp()
    const { installer: install, plugins, records } = await installer(root)
    const source = await pluginFolder(root, 'acme.notes', '1.0.0')

    const preview = await install.inspect({ kind: 'folder', path: source })
    expect(preview).toMatchObject({
      pluginId: 'acme.notes',
      name: 'Acme Notes',
      version: '1.0.0',
      permissions: ['ui.view', 'storage'],
      runsCode: false,
      existingVersion: null,
      verified: false
    })
    // Reviewing installs nothing.
    await expect(readdir(plugins)).rejects.toThrow()
    expect(await install.confirm(preview.stagingId)).toBe('acme.notes')
    expect(await readFile(join(plugins, 'acme.notes/views/index.html'), 'utf8')).toBe(
      '<p>1.0.0</p>'
    )
    expect(records()['acme.notes']).toEqual({
      source: { kind: 'folder', path: source },
      version: '1.0.0',
      installedAt: 1000
    })

    await writeFile(join(source, 'pi-desktop.json'), manifest('acme.notes', '1.1.0'))
    await writeFile(join(source, 'views', 'index.html'), '<p>1.1.0</p>')
    const update = await install.update('acme.notes')
    expect(update).toMatchObject({ version: '1.1.0', existingVersion: '1.0.0' })
    await install.confirm(update.stagingId)
    expect(await readFile(join(plugins, 'acme.notes/views/index.html'), 'utf8')).toBe(
      '<p>1.1.0</p>'
    )
    expect(await readdir(plugins)).toEqual(['acme.notes'])
    await expect(install.confirm(update.stagingId)).rejects.toThrow()

    await install.uninstall('acme.notes')
    expect(await readdir(plugins)).toEqual([])
    expect(records()).toEqual({})
    await expect(install.uninstall('acme.notes')).rejects.toThrow()
  })

  it('installs from a zip that wraps the plugin in a folder; cancelling leaves nothing', async () => {
    const root = await temp()
    const { installer: install, plugins } = await installer(root)
    const archive = join(root, 'notes.zip')
    await writeFile(
      archive,
      zip([
        { name: 'notes-main/pi-desktop.json', data: manifest('acme.notes', '2.0.0') },
        { name: 'notes-main/views/index.html', data: '<p>zip</p>', deflate: true }
      ])
    )
    const preview = await install.inspect({ kind: 'zip', path: archive })
    expect(preview.version).toBe('2.0.0')
    await install.cancel(preview.stagingId)
    await expect(readdir(plugins)).rejects.toThrow()
    expect(await readdir(join(root, 'plugin-staging'))).toEqual([])
  })

  it('refuses non-plugins, built-in ids, incompatible versions, links and other Git transports', async () => {
    const root = await temp()
    const { installer: install } = await installer(root, ['works.pi.git'])
    const empty = join(root, 'empty')
    await mkdir(empty)
    await expect(install.inspect({ kind: 'folder', path: empty })).rejects.toThrow(
      /pi-desktop.json/
    )
    const builtin = await pluginFolder(root, 'works.pi.git', '9.0.0')
    await expect(install.inspect({ kind: 'folder', path: builtin })).rejects.toThrow(/内置插件/)
    const future = await pluginFolder(root, 'acme.future', '1.0.0')
    await writeFile(
      join(future, 'pi-desktop.json'),
      manifest('acme.future', '1.0.0', { engines: { piDesktop: '>=9.0.0' } })
    )
    await expect(install.inspect({ kind: 'folder', path: future })).rejects.toThrow()
    const linked = await pluginFolder(root, 'acme.linked', '1.0.0')
    await symlink(root, join(linked, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(install.inspect({ kind: 'folder', path: linked })).rejects.toThrow(/符号链接/)
    for (const url of ['ext::sh -c touch% /tmp/pwned', 'file:///etc', 'git@github.com:a/b.git'])
      await expect(install.inspect({ kind: 'git', url })).rejects.toThrow()
    // Every refused source is cleaned up.
    expect(await readdir(join(root, 'plugin-staging'))).toEqual([])
  })
})
