import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginDevelopment } from './plugin-development'
import { PluginLogs } from './plugin-logs'

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function temp(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-plugin-dev-')))
  roots.push(root)
  return root
}

describe('plugin development', () => {
  it('keeps the folders, lists them as roots and reloads once after a burst of changes', async () => {
    vi.useFakeTimers()
    const root = await temp()
    const folder = join(root, 'notes')
    await mkdir(folder)
    let stored: string[] = []
    const changed: string[] = []
    const listeners = new Map<string, (file: string | null) => void>()
    const closed: string[] = []
    const development = new PluginDevelopment({
      folders: { get: () => stored, set: (folders) => (stored = folders) },
      onChange: (path) => changed.push(path),
      watch: (path, listener) => {
        listeners.set(path, listener)
        return { close: () => closed.push(path) }
      }
    })

    expect(await development.add(folder)).toBe(folder)
    await development.add(folder)
    expect(stored).toEqual([folder])
    expect(await development.roots()).toEqual([
      { path: folder, source: '开发中', scope: 'user', hasExecutablePiResources: false }
    ])

    const touch = listeners.get(folder)!
    touch('main.js')
    touch('views/index.html')
    touch(join('node_modules', 'x', 'index.js'))
    vi.advanceTimersByTime(100)
    touch('main.js')
    expect(changed).toEqual([])
    vi.advanceTimersByTime(250)
    expect(changed).toEqual([folder])
    // Changes inside .git or node_modules alone never reload.
    touch('.git/index')
    vi.advanceTimersByTime(1000)
    expect(changed).toEqual([folder])

    development.remove(folder)
    expect(stored).toEqual([])
    expect(closed).toEqual([folder])
    await expect(development.add(join(root, 'missing'))).rejects.toThrow()
  })

  it('watches a real folder', async () => {
    const root = await temp()
    let stored: string[] = []
    const changed = vi.fn()
    const development = new PluginDevelopment({
      folders: { get: () => stored, set: (folders) => (stored = folders) },
      onChange: changed,
      debounceMs: 20
    })
    await development.add(root)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await writeFile(join(root, 'main.js'), 'module.exports = {}')
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(root), { timeout: 5000 })
    development.dispose()
  })
})

describe('plugin logs', () => {
  it('splits process output into lines, joins partial ones and keeps the latest 500', () => {
    const logs = new PluginLogs(() => 7)
    logs.write('acme.a', 'out', 'one\ntw')
    logs.write('acme.a', 'out', 'o\r\n')
    logs.write('acme.a', 'err', 'boom\n')
    logs.append('acme.a', 'warning', 'panel says hi', 'panel')
    expect(logs.get('acme.a')).toEqual([
      { at: 7, level: 'info', text: 'one' },
      { at: 7, level: 'info', text: 'two' },
      { at: 7, level: 'error', text: 'boom' },
      { at: 7, level: 'warning', text: 'panel says hi', source: 'panel' }
    ])
    expect(logs.get('acme.b')).toEqual([])
    for (let index = 0; index < 600; index += 1) logs.append('acme.a', 'info', String(index))
    expect(logs.get('acme.a')).toHaveLength(500)
    expect(logs.get('acme.a').at(-1)?.text).toBe('599')
    logs.clear('acme.a')
    expect(logs.get('acme.a')).toEqual([])
  })
})
