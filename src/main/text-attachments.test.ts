import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TextAttachments } from './text-attachments'

describe('main-owned immutable text snapshots', () => {
  it('keeps immutable text, rejects binary/limits/symlinks and expires stale identities', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-text-stage-')))
    const scope = { projectPath: root, sessionId: 'session', generation: 1 }
    const stage = new TextAttachments()
    stage.setContext(scope)
    try {
      const path = join(root, 'sample.txt')
      await writeFile(path, 'original')
      const [item] = await stage.add(1, scope, [path])
      expect(item).toMatchObject({ name: 'sample.txt', kind: 'text', size: 8 })
      expect(JSON.stringify(item)).not.toContain(root)
      await writeFile(path, 'changed')
      expect(stage.capture(1, scope, [item.id])[0].text).toBe('original')
      await writeFile(join(root, 'binary.txt'), Buffer.from([0, 1]))
      await expect(stage.add(1, scope, [join(root, 'binary.txt')])).rejects.toThrow()
      await symlink(path, join(root, 'link.txt'))
      await expect(stage.add(1, scope, [join(root, 'link.txt')])).rejects.toThrow()
      await writeFile(join(root, 'large.txt'), 'x'.repeat(1048577))
      await expect(stage.add(1, scope, [join(root, 'large.txt')])).rejects.toThrow()
      await expect(stage.add(1, scope, [path, path, path, path])).rejects.toThrow()
      expect(() => stage.capture(2, scope, [item.id])).toThrow()
      stage.setContext({ ...scope, generation: 2 })
      stage.setContext(scope)
      expect(() => stage.capture(1, scope, [item.id])).toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('keeps BOM and extensionless UTF-8 text, bounds total bytes, expires capabilities', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-text-stage-')))
    const scope = { projectPath: root, sessionId: 'session', generation: 1 }
    const stage = new TextAttachments()
    stage.setContext(scope)
    try {
      await writeFile(join(root, 'README'), '\uFEFFexact')
      const [item] = await stage.add(1, scope, [join(root, 'README')])
      expect(stage.capture(1, scope, [item.id])[0].text).toBe('\uFEFFexact')
      await writeFile(join(root, '.editorconfig'), 'x'.repeat(1048576))
      await expect(
        stage.add(1, scope, [join(root, '.editorconfig'), join(root, '.editorconfig')])
      ).rejects.toThrow('2 MiB')
      expect(stage.list(1, scope)).toHaveLength(1)
      const original = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(original + 1800001)
      try {
        expect(() => stage.capture(1, scope, [item.id])).toThrow('过期')
      } finally {
        clock.mockRestore()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('invalidates pending reader leases across project ABA and bounds concurrent adds', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-text-stage-')))
    const scope = { projectPath: root, sessionId: 'session', generation: 1 }
    const stage = new TextAttachments()
    stage.setContext(scope)
    try {
      await writeFile(join(root, 'file.txt'), 'fixture')
      const lease = stage.lease(scope)
      const first = stage.add(1, scope, [join(root, 'file.txt')])
      await expect(stage.add(1, scope, [join(root, 'file.txt')])).rejects.toThrow('正在读取')
      stage.setContext(null)
      stage.setContext(scope)
      expect(lease).toThrow('切换')
      await expect(first).rejects.toThrow('切换')
      expect(stage.list(1, scope)).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
