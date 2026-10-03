import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { displayEnv } from './display-env'

let app: ElectronApplication, page: Page, root: string, agent: string
const artifacts = resolve('artifacts/e2e/plugin-install')

const manifest = (id: string, name: string, version: string): string =>
  JSON.stringify({
    schemaVersion: 1,
    id,
    version,
    name,
    description: `${name} panel`,
    engines: { piDesktop: '>=0.1.0' },
    permissions: ['ui.view', 'storage'],
    contributes: { views: [{ id: 'main', title: name, icon: 'plugin', entry: 'views/index.html' }] }
  })

async function pluginFolder(id: string, name: string, version: string): Promise<string> {
  const folder = join(root, 'sources', id)
  await mkdir(join(folder, 'views'), { recursive: true })
  await writeFile(join(folder, 'pi-desktop.json'), manifest(id, name, version))
  await writeFile(join(folder, 'views', 'index.html'), `<p>${name} ${version}</p>`)
  return folder
}

/** A stored (uncompressed) zip with the files under one wrapping folder, as GitHub makes them. */
function zip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path)
    const data = Buffer.from(text)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    parts.push(local, name, data)
    central.push(entry, name)
    offset += 30 + name.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

/** The next file dialog answers with this path, as if the user had chosen it. */
async function choose(path: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as never
  }, path)
}

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-plugin-install-')))
  agent = join(root, 'agent')
  for (const directory of ['home', 'agent', 'user-data', 'project', 'sources'])
    await mkdir(join(root, directory), { recursive: true })
  app = await electron.launch({
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), resolve('.')],
    env: {
      ...displayEnv(),
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      PI_DESKTOP_E2E: '1',
      PI_DESKTOP_E2E_AGENT_DIR: agent,
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data')
    }
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900))
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), join(root, 'project'))
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'Desktop 插件', exact: true }).click()
})
test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('a plugin is reviewed, installed, updated and uninstalled from Settings', async () => {
  const source = await pluginFolder('acme.notes', 'Acme Notes', '1.0.0')
  await choose(source)
  await page.getByRole('button', { name: '从文件夹安装' }).click()

  const review = page.getByRole('region', { name: '检查插件 Acme Notes' })
  await expect(review).toContainText('1.0.0')
  await expect(review).toContainText('未验证')
  await expect(review).toContainText('不运行代码')
  await expect(review.locator('li code')).toHaveText(['ui.view', 'storage'])
  await mkdir(artifacts, { recursive: true })
  await page.screenshot({ path: join(artifacts, 'review.png') })
  // Nothing is installed while the user is still reviewing.
  await expect(readdir(join(agent, 'desktop-plugins'))).rejects.toThrow()
  await review.getByRole('button', { name: '安装并启用' }).click()
  await expect(review).toHaveCount(0)

  const row = page.locator('.plugin-row').filter({ hasText: 'Acme Notes' })
  await expect(row.getByRole('switch', { name: 'Acme Notes Desktop 面板' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(row).toContainText('未验证')
  await expect(row).toContainText(`安装自 ${source}`)
  expect(await readdir(join(agent, 'desktop-plugins'))).toEqual(['acme.notes'])
  await page.screenshot({ path: join(artifacts, 'installed.png') })

  // A new version at the same source replaces it after another review.
  await writeFile(join(source, 'pi-desktop.json'), manifest('acme.notes', 'Acme Notes', '1.1.0'))
  await row.getByRole('button', { name: '检查更新' }).click()
  const update = page.getByRole('region', { name: '检查插件 Acme Notes' })
  await expect(update).toContainText('将替换已安装的 1.0.0。')
  await update.getByRole('button', { name: '更新并启用' }).click()
  await expect(row.locator('.plugin-version')).toHaveText('1.1.0')

  page.once('dialog', (dialog) => void dialog.accept())
  await row.getByRole('button', { name: '卸载' }).click()
  await expect(row).toHaveCount(0)
  expect(await readdir(join(agent, 'desktop-plugins'))).toEqual([])
})

test('a plugin installs from a zip; cancelling and unsafe sources install nothing', async () => {
  const archive = join(root, 'sources', 'board.zip')
  await writeFile(
    archive,
    zip({
      'acme-board-main/pi-desktop.json': manifest('acme.board', 'Acme Board', '2.0.0'),
      'acme-board-main/views/index.html': '<p>board</p>'
    })
  )
  await choose(archive)
  await page.getByRole('button', { name: '从 .zip 安装' }).click()
  const review = page.getByRole('region', { name: '检查插件 Acme Board' })
  await expect(review).toContainText('2.0.0')
  await review.getByRole('button', { name: '取消' }).click()
  await expect(review).toHaveCount(0)
  await expect(page.locator('.plugin-row').filter({ hasText: 'Acme Board' })).toHaveCount(0)

  await choose(archive)
  await page.getByRole('button', { name: '从 .zip 安装' }).click()
  await page
    .getByRole('region', { name: '检查插件 Acme Board' })
    .getByRole('button', { name: '安装并启用' })
    .click()
  await expect(page.locator('.plugin-row').filter({ hasText: 'Acme Board' })).toHaveCount(1)

  // Only https Git addresses are fetched; others are refused before anything runs.
  await page.getByRole('button', { name: '从 Git 地址安装' }).click()
  await page.getByRole('textbox', { name: '插件的 Git 地址' }).fill('file:///etc/plugin')
  await page.getByRole('button', { name: '下载并检查' }).click()
  await expect(page.getByRole('group', { name: '安装插件' }).getByRole('alert')).toContainText(
    '只支持 https://'
  )
  expect(await readdir(join(agent, 'desktop-plugins'))).toEqual(['acme.board'])
})
