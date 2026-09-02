import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
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
  sourcemap = false,
  generation = 'new'
): Promise<void> {
  const suffix = sourcemap ? `\n//# sourceMappingURL=${entry}.js.map\n` : '\n'
  await writeFile(join(stagingDirectory, `${entry}.js`), `${generation} ${entry}${suffix}`)
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
      rootDirectory: temporaryRoot,
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

  it('rejects a symlinked live directory before building or touching its victim', async () => {
    const victimDirectory = join(temporaryRoot, 'victim')
    await mkdir(victimDirectory)
    await writeFile(join(victimDirectory, 'sentinel.txt'), 'do not touch')
    await rm(liveDirectory, { recursive: true })
    await symlink(victimDirectory, liveDirectory, 'dir')
    let builds = 0

    await expect(
      buildAndPublishPreloads({
        rootDirectory: temporaryRoot,
        liveDirectory,
        outerIntermediateDirectory,
        async buildEntry(entry, stagingDirectory) {
          builds += 1
          await writeBundle(stagingDirectory, entry)
        }
      })
    ).rejects.toThrow('unsafe')

    expect(builds).toBe(0)
    expect(await readFile(join(victimDirectory, 'sentinel.txt'), 'utf8')).toBe('do not touch')
    expect(await listFiles(victimDirectory)).toEqual(['sentinel.txt'])
  })

  it('preserves unknown live files after successful publication', async () => {
    await writeFile(join(liveDirectory, 'user-sentinel.txt'), 'keep me')
    await mkdir(join(liveDirectory, 'user-content'))
    await writeFile(join(liveDirectory, 'user-content', 'notes.txt'), 'keep this too')

    await buildAndPublishPreloads({
      rootDirectory: temporaryRoot,
      liveDirectory,
      outerIntermediateDirectory,
      buildEntry: (entry, stagingDirectory) => writeBundle(stagingDirectory, entry)
    })

    expect(await readFile(join(liveDirectory, 'user-sentinel.txt'), 'utf8')).toBe('keep me')
    expect(await readFile(join(liveDirectory, 'user-content', 'notes.txt'), 'utf8')).toBe(
      'keep this too'
    )
  })

  it('leaves both live entries unchanged when the plugin build fails', async () => {
    await expect(
      buildAndPublishPreloads({
        rootDirectory: temporaryRoot,
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

  it('serializes concurrent generations and publishes the last complete pair', async () => {
    const generationAPluginStarted = deferred()
    const releaseGenerationA = deferred()
    const generationBStarted = deferred()
    const generationBEntries: string[] = []
    const generationA = buildAndPublishPreloads({
      rootDirectory: temporaryRoot,
      liveDirectory,
      outerIntermediateDirectory,
      async buildEntry(entry, stagingDirectory) {
        await writeBundle(stagingDirectory, entry, false, 'generation-a')
        if (entry === 'plugin') {
          generationAPluginStarted.resolve()
          await releaseGenerationA.promise
        }
      }
    })
    await generationAPluginStarted.promise

    const generationB = buildAndPublishPreloads({
      rootDirectory: temporaryRoot,
      liveDirectory,
      outerIntermediateDirectory,
      async buildEntry(entry, stagingDirectory) {
        generationBEntries.push(entry)
        generationBStarted.resolve()
        await writeBundle(stagingDirectory, entry, false, 'generation-b')
      }
    })
    const generationBStartedWhileAWasActive = await Promise.race([
      generationBStarted.promise.then(() => true),
      new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 25))
    ])

    releaseGenerationA.resolve()
    await Promise.all([generationA, generationB])

    expect(generationBStartedWhileAWasActive).toBe(false)
    expect(generationBEntries).toEqual(['index', 'plugin'])
    expect(await readFile(join(liveDirectory, 'index.js'), 'utf8')).toBe('generation-b index\n')
    expect(await readFile(join(liveDirectory, 'plugin.js'), 'utf8')).toBe('generation-b plugin\n')
  })

  it('runs a queued generation after the active generation fails', async () => {
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const first = buildAndPublishPreloads({
      rootDirectory: temporaryRoot,
      liveDirectory,
      outerIntermediateDirectory,
      async buildEntry(entry, stagingDirectory) {
        await writeBundle(stagingDirectory, entry, false, 'failed-generation')
        if (entry === 'index') {
          firstStarted.resolve()
          await releaseFirst.promise
        } else {
          throw new Error('active generation failed')
        }
      }
    })
    await firstStarted.promise
    const queuedEntries: string[] = []
    const queued = buildAndPublishPreloads({
      rootDirectory: temporaryRoot,
      liveDirectory,
      outerIntermediateDirectory,
      async buildEntry(entry, stagingDirectory) {
        queuedEntries.push(entry)
        await writeBundle(stagingDirectory, entry, false, 'queued-generation')
      }
    })

    releaseFirst.resolve()
    await expect(first).rejects.toThrow('active generation failed')
    await expect(queued).resolves.toBeUndefined()

    expect(queuedEntries).toEqual(['index', 'plugin'])
    expect(await readFile(join(liveDirectory, 'index.js'), 'utf8')).toBe(
      'queued-generation index\n'
    )
    expect(await readFile(join(liveDirectory, 'plugin.js'), 'utf8')).toBe(
      'queued-generation plugin\n'
    )
  })

  it('rolls back the complete generated pair when a later atomic replace fails', async () => {
    await writeFile(join(liveDirectory, 'index.js.map'), 'old index map')
    await writeFile(join(liveDirectory, 'plugin.js.map'), 'old plugin map')
    let failed = false

    await expect(
      buildAndPublishPreloads({
        rootDirectory: temporaryRoot,
        liveDirectory,
        outerIntermediateDirectory,
        buildEntry: (entry, stagingDirectory) => writeBundle(stagingDirectory, entry, true),
        async replaceFile(source, destination) {
          if (!failed && source.includes('.ready') && destination.endsWith('plugin.js')) {
            failed = true
            throw new Error('injected plugin replace failure')
          }
          await rename(source, destination)
        }
      })
    ).rejects.toThrow('injected plugin replace failure')

    expect(await readFile(join(liveDirectory, 'index.js'), 'utf8')).toBe('old index')
    expect(await readFile(join(liveDirectory, 'plugin.js'), 'utf8')).toBe('old plugin sentinel')
    expect(await readFile(join(liveDirectory, 'index.js.map'), 'utf8')).toBe('old index map')
    expect(await readFile(join(liveDirectory, 'plugin.js.map'), 'utf8')).toBe('old plugin map')
    expect((await readdir(liveDirectory)).filter((name) => name.startsWith('.'))).toEqual([])
  })

  it('preserves backups and reports an incomplete rollback', async () => {
    let publishFailed = false

    await expect(
      buildAndPublishPreloads({
        rootDirectory: temporaryRoot,
        liveDirectory,
        outerIntermediateDirectory,
        buildEntry: (entry, stagingDirectory) => writeBundle(stagingDirectory, entry),
        async replaceFile(source, destination) {
          if (!publishFailed && source.includes('.ready') && destination.endsWith('plugin.js')) {
            publishFailed = true
            throw new Error('injected publish failure')
          }
          if (source.includes('.rollback')) throw new Error('injected rollback failure')
          await rename(source, destination)
        }
      })
    ).rejects.toThrow('rollback was incomplete')

    expect((await readdir(liveDirectory)).filter((name) => name.includes('.backup'))).not.toEqual(
      []
    )
  })

  it('publishes matching entries and maps while removing stale live artifacts', async () => {
    await mkdir(join(liveDirectory, 'chunks'))
    await writeFile(join(liveDirectory, 'chunks', 'stale.js'), 'stale')
    await writeFile(join(liveDirectory, 'index.js.map'), 'stale map')

    await buildAndPublishPreloads({
      rootDirectory: temporaryRoot,
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
