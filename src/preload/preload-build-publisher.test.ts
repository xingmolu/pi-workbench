import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAndPublishPreloads } from './preload-build-publisher'

type Deferred = {
  promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function writeBundle(
  stagingDirectory: string,
  entry: 'index' | 'plugin',
  sourcemap = false
): Promise<void> {
  const suffix = sourcemap ? `\n//# sourceMappingURL=${entry}.js.map\n` : '\n'
  await writeFile(join(stagingDirectory, `${entry}.js`), `new ${entry}${suffix}`)
  if (sourcemap) {
    await writeFile(
      join(stagingDirectory, `${entry}.js.map`),
      JSON.stringify({ sources: [`../../src/preload/${entry}.ts`] })
    )
  }
}

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = join(prefix, entry.name)
    if (entry.isDirectory())
      result.push(...(await listFiles(join(directory, entry.name), relativePath)))
    else result.push(relativePath)
  }
  return result.sort()
}

describe('atomic preload build publication', () => {
  let temporaryRoot: string
  let outputDirectory: string
  let liveDirectory: string
  let outerIntermediateDirectory: string

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'pi-preload-publisher-'))
    outputDirectory = join(temporaryRoot, 'out')
    liveDirectory = join(outputDirectory, 'preload')
    outerIntermediateDirectory = join(outputDirectory, '.preload-outer')
    await mkdir(liveDirectory, { recursive: true })
    await mkdir(outerIntermediateDirectory, { recursive: true })
    await writeFile(join(liveDirectory, 'index.js'), 'old index')
    await writeFile(join(liveDirectory, 'plugin.js'), 'old plugin sentinel')
    await writeFile(join(outerIntermediateDirectory, 'outer.js'), 'transient outer output')
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('keeps live entries readable until both staged entry builds finish', async () => {
    const indexStarted = deferred()
    const pluginStarted = deferred()
    const finishIndex = deferred()
    const finishPlugin = deferred()
    const operation = buildAndPublishPreloads({
      liveDirectory,
      outerIntermediateDirectory,
      async buildEntry(entry, stagingDirectory) {
        await writeBundle(stagingDirectory, entry)
        if (entry === 'index') {
          indexStarted.resolve()
          await finishIndex.promise
        } else {
          pluginStarted.resolve()
          await finishPlugin.promise
        }
      }
    })

    await indexStarted.promise
    expect(await readFile(join(liveDirectory, 'plugin.js'), 'utf8')).toBe('old plugin sentinel')

    finishIndex.resolve()
    await pluginStarted.promise
    expect(await readFile(join(liveDirectory, 'index.js'), 'utf8')).toBe('old index')
    expect(await readFile(join(liveDirectory, 'plugin.js'), 'utf8')).toBe('old plugin sentinel')

    finishPlugin.resolve()
    await operation
    expect(await readFile(join(liveDirectory, 'index.js'), 'utf8')).toBe('new index\n')
    expect(await readFile(join(liveDirectory, 'plugin.js'), 'utf8')).toBe('new plugin\n')
  })

  it('leaves both live entries unchanged when the plugin build fails', async () => {
    await expect(
      buildAndPublishPreloads({
        liveDirectory,
        outerIntermediateDirectory,
        async buildEntry(entry, stagingDirectory) {
          await writeBundle(stagingDirectory, entry)
          if (entry === 'plugin') throw new Error('plugin build failed')
        }
      })
    ).rejects.toThrow('plugin build failed')

    expect(await readFile(join(liveDirectory, 'index.js'), 'utf8')).toBe('old index')
    expect(await readFile(join(liveDirectory, 'plugin.js'), 'utf8')).toBe('old plugin sentinel')
    await expect(access(outerIntermediateDirectory)).rejects.toThrow()
    expect(
      (await readdir(outputDirectory)).filter((name) => name.startsWith('.preload-stage-'))
    ).toEqual([])
  })

  it('publishes matching entries and maps while removing stale live artifacts', async () => {
    await mkdir(join(liveDirectory, 'chunks'))
    await writeFile(join(liveDirectory, 'chunks', 'stale.js'), 'stale')
    await writeFile(join(liveDirectory, 'index.js.map'), 'stale map')

    await buildAndPublishPreloads({
      liveDirectory,
      outerIntermediateDirectory,
      buildEntry: (entry, stagingDirectory) => writeBundle(stagingDirectory, entry, true)
    })

    expect(await listFiles(liveDirectory)).toEqual([
      'index.js',
      'index.js.map',
      'plugin.js',
      'plugin.js.map'
    ])
    expect(await readFile(join(liveDirectory, 'index.js'), 'utf8')).toContain(
      'sourceMappingURL=index.js.map'
    )
    expect(await readFile(join(liveDirectory, 'plugin.js'), 'utf8')).toContain(
      'sourceMappingURL=plugin.js.map'
    )
    expect(JSON.parse(await readFile(join(liveDirectory, 'index.js.map'), 'utf8'))).toEqual({
      sources: ['../../src/preload/index.ts']
    })
    expect(JSON.parse(await readFile(join(liveDirectory, 'plugin.js.map'), 'utf8'))).toEqual({
      sources: ['../../src/preload/plugin.ts']
    })
    expect((await readdir(outputDirectory)).map((entry) => basename(entry)).sort()).toEqual([
      'preload'
    ])
  })
})
