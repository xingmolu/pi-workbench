import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { importPiHistory, legacyPiHistory } from './pi-history-import'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
it('imports native history once, preserves source bytes, rewrites fork links and excludes credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-import-'))
  roots.push(root)
  const source = join(root, 'legacy'),
    destination = join(root, 'app')
  await mkdir(join(source, 'bucket'), { recursive: true })
  const parent = join(source, 'bucket', 'parent.jsonl')
  const original = JSON.stringify({ type: 'session', cwd: '/project', id: 'parent' }) + '\n'
  await writeFile(parent, original)
  await writeFile(
    join(source, 'bucket', 'child.jsonl'),
    JSON.stringify({ type: 'session', cwd: '/project', id: 'child', parentSession: parent }) + '\n'
  )
  await writeFile(join(source, 'auth.json'), 'secret')
  await writeFile(join(source, 'bucket', 'broken.jsonl'), '{invalid')
  expect((await legacyPiHistory(source)).count).toBe(3)
  expect(await importPiHistory(source, destination)).toEqual({ imported: 2, skipped: 1 })
  expect(await importPiHistory(source, destination)).toEqual({ imported: 0, skipped: 3 })
  expect(await readFile(parent, 'utf8')).toBe(original)
  expect(
    JSON.parse(await readFile(join(destination, 'bucket', 'child.jsonl'), 'utf8'))
  ).toMatchObject({ parentSession: join(destination, 'bucket', 'parent.jsonl') })
  await expect(readFile(join(destination, 'auth.json'))).rejects.toThrow()
})
