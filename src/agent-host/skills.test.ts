import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { SkillsCatalog } from './skills'
import { hostCommandSchema, hostRequestSchema, hostResultSchema } from '../shared/schemas'
import { hostResultMatchesCommand } from '../shared/command-result'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
test('catalog exposes loaded SDK metadata without paths and distinguishes manual invocation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-skills-'))
  dirs.push(dir)
  const filePath = join(dir, 'SKILL.md')
  await writeFile(filePath, '# Example')
  const skills = [
    {
      name: 'example',
      description: 'Example skill',
      filePath,
      baseDir: dir,
      sourceInfo: {
        scope: 'project' as const,
        origin: 'top-level' as const,
        path: dir,
        source: dir
      },
      disableModelInvocation: true
    }
  ]
  const catalog = new SkillsCatalog(() => ({ sessionId: 's', generation: 1, skills }))
  const result = await catalog.list({ sessionId: 's', generation: 1 })
  expect(result.skills).toEqual([
    expect.objectContaining({
      name: 'example',
      scope: 'project',
      mode: 'manual-only',
      canInsert: true
    })
  ])
  expect(JSON.stringify(result)).not.toContain(dir)
  expect(
    (await catalog.detail({ sessionId: 's', generation: 1, id: result.skills[0].id })).preview
  ).toBe('# Example')
})

async function fixture(content: string | Buffer = '# Body') {
  const dir = await mkdtemp(join(tmpdir(), 'pi-skills-'))
  dirs.push(dir)
  const filePath = join(dir, 'SKILL.md')
  await writeFile(filePath, content)
  const skill = {
    name: 'example',
    description: 'Example skill',
    filePath,
    baseDir: dir,
    sourceInfo: { scope: 'user' as const, origin: 'package' as const, path: dir, source: dir },
    disableModelInvocation: false
  }
  const state = { sessionId: 's', generation: 1, skills: [skill] }
  return { state, skill, filePath, catalog: new SkillsCatalog(() => state) }
}

test('duplicate and unsafe names are inspectable but never insertable; catalog is bounded', async () => {
  const { state, skill, catalog } = await fixture()
  state.skills = [
    skill,
    { ...skill },
    { ...skill, name: 'bad\ncommand' },
    ...Array.from({ length: 260 }, (_, i) => ({ ...skill, name: `safe-${i}` }))
  ]
  const result = await catalog.list(state)
  expect(result.skills.slice(0, 3).every((item) => !item.canInsert)).toBe(true)
  expect(result.skills).toHaveLength(256)
  expect(result).toMatchObject({ total: 263, truncated: true })
  expect(result.skills[3]).toMatchObject({
    scope: 'user',
    origin: 'package',
    mode: 'model-and-manual',
    canInsert: true
  })
})

test('unknown opaque ids and caller file paths cannot read any file', async () => {
  const { catalog, state } = await fixture()
  await catalog.list(state)
  await expect(catalog.detail({ ...state, id: '../../etc/passwd' })).rejects.toThrow(
    '当前已加载列表'
  )
  const command = { type: 'skills:list', sessionId: 's', generation: 1 } as const
  expect(hostCommandSchema.safeParse(command).success).toBe(true)
  expect(hostRequestSchema.safeParse({ ...command, requestId: 'r' }).success).toBe(true)
  const detail = { ...command, type: 'skills:detail', id: 'c9557759-94b9-4943-a25f-084bf742f419' }
  expect(hostRequestSchema.safeParse({ ...detail, requestId: 'r' }).success).toBe(true)
  expect(hostCommandSchema.safeParse({ ...detail, filePath: '/etc/passwd' }).success).toBe(false)
  expect(
    hostRequestSchema.safeParse({ ...detail, requestId: 'r', filePath: '/etc/passwd' }).success
  ).toBe(false)
  expect(hostCommandSchema.safeParse({ ...detail, id: '../secret' }).success).toBe(false)
  const result = { kind: 'skills-list', catalog: await catalog.list(state) } as const
  expect(hostResultSchema.safeParse(result).success).toBe(true)
  expect(hostResultMatchesCommand(command, result)).toBe(true)
  const envelope = { ...command, requestId: 'opaque-request' }
  expect(
    hostResultSchema.safeParse({ kind: 'skills-list', catalog: await catalog.list(envelope) })
      .success
  ).toBe(true)
})

test.each([Buffer.from([0, 65]), Buffer.from([0xff, 0xfe]), 'a'.repeat(65537)])(
  'binary, invalid UTF8 and oversized previews fail without path leakage',
  async (content) => {
    const { state, catalog, filePath } = await fixture(content)
    const list = await catalog.list(state)
    const error = await catalog.detail({ ...state, id: list.skills[0].id }).catch((error) => error)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).not.toContain(filePath)
  }
)

test('file edits and removal from the SDK allowlist invalidate previews', async () => {
  const { state, catalog, filePath } = await fixture()
  const list = await catalog.list(state)
  await writeFile(filePath, '# Changed')
  await expect(catalog.detail({ ...state, id: list.skills[0].id })).rejects.toThrow('文件已更改')
  state.skills = []
  await expect(catalog.detail({ ...state, id: list.skills[0].id })).rejects.toThrow(
    '当前已加载列表'
  )
})

test('session changes before and during asynchronous catalog/preview work discard results', async () => {
  const { state, catalog } = await fixture()
  const pending = catalog.list({ sessionId: 's', generation: 1 })
  state.generation = 2
  await expect(pending).rejects.toThrow('会话已变化')
  const list = await catalog.list(state)
  await expect(
    catalog.detail({ sessionId: 'old', generation: 2, id: list.skills[0].id })
  ).rejects.toThrow('会话已变化')
  const detail = catalog.detail({ sessionId: 's', generation: 2, id: list.skills[0].id })
  state.generation = 3
  await expect(detail).rejects.toThrow('会话已变化')
})
