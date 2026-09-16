import { mkdtemp, readFile, rm, mkdir, writeFile, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarkdownTableExporter } from './markdown-table-export'
const faults = vi.hoisted(() => ({
  write: false,
  collide: false,
  changedTarget: '',
  closeWindow: undefined as (() => void) | undefined
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (faults.collide) {
        await actual.writeFile(args[0], 'belongs to someone else')
        const error = new Error('collision') as NodeJS.ErrnoException
        error.code = 'EEXIST'
        throw error
      }
      const handle = await actual.open(...args)
      const write = handle.writeFile.bind(handle)
      handle.writeFile = async (...data) => {
        if (faults.write) throw new Error('synthetic disk failure')
        await write(...data)
        if (faults.changedTarget) await actual.writeFile(faults.changedTarget, 'external change')
        faults.closeWindow?.()
      }
      return handle
    }
  }
})
let root: string
beforeEach(async () => {
  faults.write = false
  faults.collide = false
  faults.changedTarget = ''
  faults.closeWindow = undefined
  root = await mkdtemp(join(tmpdir(), 'pi-table-unit-'))
})
it('cleans only its own temp on write failure and preserves an exclusive-open collision', async () => {
  const filePath = join(root, 'old.csv')
  await writeFile(filePath, 'previous')
  const exporter = new MarkdownTableExporter(async () => ({ canceled: false, filePath }))
  faults.write = true
  expect((await exporter.export(owner, request)).status).toBe('failed')
  expect(await readFile(filePath, 'utf8')).toBe('previous')
  expect(await readdir(root)).toEqual(['old.csv'])
  faults.write = false
  faults.collide = true
  expect((await exporter.export(owner, request)).status).toBe('failed')
  const collision = (await readdir(root)).find((name) => name.startsWith('.pi-table-'))!
  expect(await readFile(join(root, collision), 'utf8')).toBe('belongs to someone else')
})
it('refuses detected external changes and a window closing during a write', async () => {
  const filePath = join(root, 'old.csv')
  await writeFile(filePath, 'previous')
  const exporter = new MarkdownTableExporter(async () => ({ canceled: false, filePath }))
  faults.changedTarget = filePath
  expect((await exporter.export(owner, request)).status).toBe('failed')
  expect(await readFile(filePath, 'utf8')).toBe('external change')
  faults.changedTarget = ''
  let closed = false
  faults.closeWindow = () => {
    closed = true
  }
  expect((await exporter.export({ id: 3, isDestroyed: () => closed }, request)).status).toBe(
    'failed'
  )
  expect(await readdir(root)).toEqual(['old.csv'])
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const owner = { id: 1, isDestroyed: () => false }
const request = { mode: 'raw', cells: [['标题', '00123']] }
it('saves exact BOM CSV to user selected path and replaces existing ordinary file', async () => {
  const filePath = join(root, '表格.csv')
  await writeFile(filePath, 'previous')
  const exporter = new MarkdownTableExporter(async () => ({ canceled: false, filePath }))
  expect(await exporter.export(owner, request)).toEqual({ status: 'saved' })
  expect(await readFile(filePath, 'utf8')).toBe('\uFEFF"标题","00123"')
  expect(await readdir(root)).toEqual(['表格.csv'])
})
it('cancels distinctly and validates before opening a dialog', async () => {
  let dialogs = 0
  const exporter = new MarkdownTableExporter(async () => {
    dialogs++
    return { canceled: true }
  })
  expect((await exporter.export(owner, {})).status).toBe('failed')
  expect(dialogs).toBe(0)
  expect(
    (await exporter.export(owner, { mode: 'raw', cells: [['x'.repeat(1024 * 1024)]] })).status
  ).toBe('failed')
  expect(dialogs).toBe(0)
  expect(await exporter.export(owner, request)).toEqual({ status: 'cancelled' })
})
it('bounds dialogs globally and discards a result from a window closed during its dialog', async () => {
  const resolvers: Array<(value: { canceled: boolean; filePath: string }) => void> = []
  const exporter = new MarkdownTableExporter(
    () => new Promise((resolve) => resolvers.push(resolve))
  )
  let closed = false
  const jobs = Array.from({ length: 4 }, (_, id) =>
    exporter.export({ id, isDestroyed: () => closed }, request)
  )
  expect((await exporter.export({ id: 5, isDestroyed: () => false }, request)).status).toBe(
    'failed'
  )
  closed = true
  for (const finish of resolvers) finish({ canceled: false, filePath: join(root, 'closed.csv') })
  expect((await Promise.all(jobs)).map((result) => result.status)).toEqual([
    'failed',
    'failed',
    'failed',
    'failed'
  ])
  expect(await readdir(root)).toEqual([])
})
it('deduplicates window dialogs and captures data before await', async () => {
  let finish!: (value: { canceled: boolean; filePath: string }) => void
  const exporter = new MarkdownTableExporter(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const input = { mode: 'raw', cells: [['before']] }
  const pending = exporter.export(owner, input)
  input.cells[0][0] = 'after'
  expect((await exporter.export(owner, request)).status).toBe('failed')
  finish({ canceled: false, filePath: join(root, 'out.csv') })
  expect((await pending).status).toBe('saved')
  expect(await readFile(join(root, 'out.csv'), 'utf8')).toBe('\uFEFF"before"')
})
it('refuses directories, symlinks, missing parents and closed windows', async () => {
  await mkdir(join(root, 'directory'))
  await writeFile(join(root, 'original'), 'keep')
  await symlink(join(root, 'original'), join(root, 'link'))
  for (const name of ['directory', 'link', 'missing/out'])
    expect(
      (
        await new MarkdownTableExporter(async () => ({
          canceled: false,
          filePath: join(root, name)
        })).export(owner, request)
      ).status
    ).toBe('failed')
  const exporter = new MarkdownTableExporter(async () => ({
    canceled: false,
    filePath: join(root, 'closed')
  }))
  expect((await exporter.export({ id: 2, isDestroyed: () => true }, request)).status).toBe('failed')
  expect(await readFile(join(root, 'original'), 'utf8')).toBe('keep')
})
