import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { displayEnv } from './display-env'
import { openWorkbenchTool } from './workbench-helpers'

let app: ElectronApplication, page: Page, root: string, workspace: string
const artifacts = resolve('artifacts/e2e/plugin-development')

/** The next file dialog answers with this path, as if the user had chosen it. */
async function choose(path: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as never
  }, path)
}

async function openPluginSettings(): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'Desktop 插件', exact: true }).click()
}

async function create(name: string, template: string): Promise<void> {
  await choose(workspace)
  await page.getByRole('button', { name: '新建插件' }).click()
  const form = page.getByRole('form', { name: '新建插件' })
  await form.getByRole('textbox', { name: '名称' }).fill(name)
  await form.getByRole('radio', { name: new RegExp(template) }).check()
  await form.getByRole('button', { name: '选择位置并创建' }).click()
  await expect(form).toHaveCount(0)
}

/** Evaluates in the plugin page whose URL ends with `suffix`, once one is loaded. */
async function inPanel(suffix: string, script: string): Promise<unknown> {
  return app.evaluate(
    ({ webContents }, { suffix, script }) =>
      webContents
        .getAllWebContents()
        .find((contents) => !contents.isDestroyed() && contents.getURL().endsWith(suffix))
        ?.executeJavaScript(script)
        .catch(() => undefined),
    { suffix, script }
  )
}

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-plugin-dev-')))
  workspace = join(root, 'plugins')
  for (const directory of ['home', 'agent', 'user-data', 'project', 'plugins'])
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
      PI_DESKTOP_E2E_AGENT_DIR: join(root, 'agent'),
      PI_DESKTOP_E2E_USER_DATA: join(root, 'user-data')
    }
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900))
  await expect.poll(() => page.evaluate(async () => (await window.pi.getState()).ready)).toBe(true)
  await page.evaluate((cwd) => window.pi.send({ type: 'project:open', cwd }), join(root, 'project'))
  await openPluginSettings()
})
test.afterEach(async () => {
  await app?.close()
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('a new panel plugin is created, shown, and reloads when its files change', async () => {
  await create('Acme Notes', '面板')
  const folder = join(workspace, 'acme-notes')
  const manifest = JSON.parse(await readFile(join(folder, 'pi-desktop.json'), 'utf8'))
  expect(manifest).toMatchObject({ id: 'local.acme-notes', name: 'Acme Notes' })
  // Editors get the plugin API and manifest schema without installing anything.
  await stat(join(folder, 'types', 'pi-desktop.d.ts'))
  await stat(join(folder, 'types', 'pi-desktop.schema.json'))

  const row = page.locator('.plugin-row').filter({ hasText: 'Acme Notes' })
  await expect(row.locator('.plugin-badge.is-development')).toHaveText('开发中')
  await expect(row.getByRole('switch', { name: 'Acme Notes Desktop 面板' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await mkdir(artifacts, { recursive: true })
  await page.screenshot({ path: join(artifacts, 'created.png') })

  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await openWorkbenchTool(page, 'Acme Notes')
  await expect
    .poll(() => inPanel('/views/index.html', "document.querySelector('h1')?.textContent"))
    .toBe('Acme Notes')

  // Saving a file reloads the panel in place.
  const html = join(folder, 'views', 'index.html')
  await writeFile(
    html,
    (await readFile(html, 'utf8')).replace('<h1>Acme Notes</h1>', '<h1>Version 2</h1>')
  )
  const script = join(folder, 'views', 'main.js')
  await writeFile(script, `${await readFile(script, 'utf8')}\nconsole.warn('panel version 2')\n`)
  await expect
    .poll(() => inPanel('/views/index.html', "document.querySelector('h1')?.textContent"), {
      timeout: 15_000
    })
    .toBe('Version 2')
  await page.screenshot({ path: join(artifacts, 'reloaded-panel.png') })

  // The panel's console shows up in the plugin's log.
  await openPluginSettings()
  await row.getByRole('button', { name: '日志' }).click()
  await expect(row.getByRole('region', { name: '插件日志' })).toContainText('panel version 2')
  await page.screenshot({ path: join(artifacts, 'logs.png') })
})

test('a command plugin restarts on change; a broken manifest is shown until fixed', async () => {
  await create('Acme Hello', '命令')
  const folder = join(workspace, 'acme-hello')
  const row = page.locator('.plugin-row').filter({ hasText: 'Acme Hello' })
  await expect(row).toContainText('运行中')
  await row.getByRole('button', { name: '日志' }).click()
  const logs = row.getByRole('region', { name: '插件日志' })
  await expect(logs).toContainText('loaded')

  // A new process runs the changed code.
  const main = join(folder, 'main.js')
  await writeFile(
    main,
    (await readFile(main, 'utf8')).replace("console.log('loaded')", "console.log('second version')")
  )
  await expect(logs).toContainText('second version', { timeout: 15_000 })
  await expect(logs).toContainText('已重新加载')

  // A manifest that no longer parses takes the plugin out and says why.
  const manifestPath = join(folder, 'pi-desktop.json')
  const manifest = await readFile(manifestPath, 'utf8')
  await writeFile(manifestPath, manifest.replace('"version": "0.1.0"', '"version": 3'))
  const problem = page.getByRole('group', { name: folder })
  await expect(problem).toContainText('未能加载', { timeout: 15_000 })
  await expect(problem).toContainText('version')
  await expect(row).toHaveCount(0)
  await page.screenshot({ path: join(artifacts, 'broken.png') })
  await writeFile(manifestPath, manifest.replace('"version": "0.1.0"', '"version": "0.2.0"'))
  await expect(row.locator('.plugin-version')).toHaveText('0.2.0', { timeout: 15_000 })
  await expect(problem).toHaveCount(0)

  // Stopping development unloads it and leaves the folder alone.
  await row.getByRole('button', { name: '停止开发' }).click()
  await expect(row).toHaveCount(0)
  await stat(manifestPath)
})

test('the TODO example loads from its folder and its panel asks its process', async () => {
  await writeFile(join(root, 'project', 'app.ts'), '// TODO: ship it\nexport {}\n')
  await choose(resolve('examples/plugins/todo-finder'))
  await page.getByRole('button', { name: '加载开发中的插件' }).click()
  const row = page.locator('.plugin-row').filter({ hasText: 'TODO 查找' })
  await expect(row.locator('.plugin-badge.is-development')).toBeVisible()
  await expect(row).toContainText('运行中')

  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await openWorkbenchTool(page, 'TODO')
  await expect
    .poll(() => inPanel('/views/index.html', "document.getElementById('summary')?.textContent"))
    .toBe('找到 1 条')
  expect(await inPanel('/views/index.html', "document.querySelector('li')?.textContent")).toContain(
    'app.ts:1'
  )

  // Removing it leaves the example folder where it is.
  await openPluginSettings()
  await row.getByRole('button', { name: '停止开发' }).click()
  await expect(row).toHaveCount(0)
})
