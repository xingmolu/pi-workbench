import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginApiError } from '../shared/plugin-api'
import {
  MobilePluginViews,
  mobileMethodAccess,
  type MobilePluginSource
} from './mobile-plugin-views'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(): Promise<{ views: MobilePluginViews; ran: string[]; root: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mobile-plugin-')))
  roots.push(base)
  const root = join(base, 'plugin')
  await mkdir(join(root, 'views'), { recursive: true })
  await writeFile(join(root, 'views', 'page.html'), '<html><head><title>x</title></head></html>')
  await writeFile(join(root, 'views', 'page.js'), 'void 0')
  await writeFile(join(root, '.secret.js'), 'secret')
  await writeFile(join(base, 'outside.js'), 'outside')
  const ran: string[] = []
  const source: MobilePluginSource = {
    views: () => [
      {
        id: 'acme.tool.page',
        pluginId: 'acme.tool',
        pluginName: 'Tool',
        title: 'Page',
        available: true,
        root,
        entryPath: join(root, 'views', 'page.html')
      }
    ],
    context: (viewId) => ({
      pluginId: 'acme.tool',
      viewId,
      projectPath: '/p',
      sessionId: null,
      generation: 1
    }),
    call: async (_viewId, method, _params, approve) => {
      if (method === 'git.commit' && !(await approve({ title: '提交', detail: 'msg' })))
        throw new PluginApiError('PERMISSION_DENIED', '用户拒绝了这次操作')
      ran.push(method)
      return { method }
    }
  }
  return { views: new MobilePluginViews(source), ran, root }
}

it('limits phone calls to host methods, and writes to control access', async () => {
  expect(mobileMethodAccess('git.status')).toBe('view')
  expect(mobileMethodAccess('git.push')).toBe('control')
  expect(mobileMethodAccess('clipboard.write')).toBeNull()
  expect(mobileMethodAccess('ui.openView')).toBeNull()
  expect(mobileMethodAccess('my.custom.channel')).toBeNull()
  const { views, ran } = await fixture()
  const call = { viewId: 'acme.tool.page', method: 'git.status', params: {} }
  expect(await views.call('d1', 'view', call)).toEqual({
    ok: true,
    value: { method: 'git.status' }
  })
  expect(await views.call('d1', 'off', call)).toMatchObject({
    ok: false,
    code: 'PERMISSION_DENIED'
  })
  expect(await views.call('d1', 'view', { ...call, method: 'git.commit' })).toMatchObject({
    ok: false,
    code: 'PERMISSION_DENIED'
  })
  expect(ran).toEqual(['git.status'])
})

it('asks the phone before a confirmed write and accepts the answer once, for that call only', async () => {
  const { views, ran } = await fixture()
  const call = { viewId: 'acme.tool.page', method: 'git.commit', params: { message: 'a' } }
  const asked = await views.call('d1', 'control', call)
  expect(asked).toMatchObject({ ok: false, confirm: { title: '提交', detail: 'msg' } })
  expect(ran).toEqual([])
  const token = (asked as { confirm: { token: string } }).confirm.token
  // Another device, or different parameters, cannot spend the answer.
  expect(await views.call('d2', 'control', { ...call, confirm: token })).toHaveProperty('confirm')
  expect(
    await views.call('d1', 'control', { ...call, params: { message: 'b' }, confirm: token })
  ).toHaveProperty('confirm')
  expect(await views.call('d1', 'control', { ...call, confirm: token })).toEqual({
    ok: true,
    value: { method: 'git.commit' }
  })
  expect(await views.call('d1', 'control', { ...call, confirm: token })).toHaveProperty('confirm')
  expect(ran).toEqual(['git.commit'])
})

it('serves only files inside the plugin root through a frame token, with the bridge injected', async () => {
  const { views } = await fixture()
  const { url } = views.open('d1', 'acme.tool.page')
  expect(url).toMatch(/^\/plugin-frame\/[\w-]+\/views\/page\.html$/)
  const page = await views.file(url)
  expect(String(page?.body)).toMatch(
    /<head><script src="\/plugin-frame\/[\w-]+\/__pi_mobile_bridge\.js">/
  )
  const base = url.slice(0, url.lastIndexOf('/views/'))
  expect((await views.file(`${base}/views/page.js`))?.type).toContain('javascript')
  expect(String((await views.file(`${base}/__pi_mobile_bridge.js`))?.body)).toContain('piPlugin')
  expect(await views.file(`${base}/../outside.js`)).toBeNull()
  expect(await views.file(`${base}/%2E%2E/outside.js`)).toBeNull()
  expect(await views.file(`${base}/.secret.js`)).toBeNull()
  expect(await views.file('/plugin-frame/not-a-token/views/page.js')).toBeNull()
  expect(() => views.open('d1', 'acme.other.page')).toThrow('没有开放给手机')
})
