import { createHash } from 'node:crypto'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Native SDK plugins expose granted desktop skill directories without copying their content. */
export async function nativeSkillPlugins(cache: string, skillPaths: readonly string[]) {
  return Promise.all(
    skillPaths.map(async (path) => {
      const id = createHash('sha256').update(path).digest('hex').slice(0, 16)
      const root = join(cache, 'skill-plugins', id)
      await mkdir(join(root, '.claude-plugin'), { recursive: true })
      await writeFile(
        join(root, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: `desktop-skills-${id}`, version: '1.0.0' })
      )
      try {
        await symlink(path, join(root, 'skills'), 'dir')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      return { type: 'local' as const, path: root }
    })
  )
}
