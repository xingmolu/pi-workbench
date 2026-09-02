import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const PRELOAD_ENTRIES = ['index', 'plugin'] as const
const GENERATED_ARTIFACTS = ['index.js', 'index.js.map', 'plugin.js', 'plugin.js.map'] as const
type PreloadEntry = (typeof PRELOAD_ENTRIES)[number]
type GeneratedArtifact = (typeof GENERATED_ARTIFACTS)[number]

type ReplaceFile = (source: string, destination: string, displaced: string) => Promise<void>

type BuildAndPublishPreloadsOptions = {
  rootDirectory: string
  liveDirectory: string
  outerIntermediateDirectory: string
  buildEntry(entry: PreloadEntry, stagingDirectory: string): Promise<void>
  replaceFile?: ReplaceFile
}

type ValidatedDirectories = {
  liveDirectory: string
  liveCanonical: string
  outerIntermediateDirectory: string
  outputDirectory: string
}

type ArtifactRecord = {
  artifact: GeneratedArtifact
  live: string
  ready: string
  backup: string
  rollback: string
  displaced: string
  existed: boolean
}

const publicationQueues = new Map<string, Promise<void>>()

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

async function ensureRealDirectory(path: string): Promise<string> {
  let metadata = await optionalLstat(path)
  if (!metadata) {
    await mkdir(path)
    metadata = await lstat(path)
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Preload publication directories are unsafe')
  }
  return realpath(path)
}

async function validateDirectories(
  options: BuildAndPublishPreloadsOptions
): Promise<ValidatedDirectories> {
  const rootDirectory = resolve(options.rootDirectory)
  const outputDirectory = resolve(rootDirectory, 'out')
  const liveDirectory = resolve(options.liveDirectory)
  const outerIntermediateDirectory = resolve(options.outerIntermediateDirectory)
  if (
    !isAbsolute(options.rootDirectory) ||
    !isAbsolute(options.liveDirectory) ||
    !isAbsolute(options.outerIntermediateDirectory) ||
    liveDirectory !== resolve(outputDirectory, 'preload') ||
    outerIntermediateDirectory !== resolve(outputDirectory, '.preload-outer')
  ) {
    throw new Error('Preload publication directories are unsafe')
  }

  const rootCanonical = await realpath(rootDirectory)
  const outputCanonical = await ensureRealDirectory(outputDirectory)
  if (dirname(outputCanonical) !== rootCanonical || basename(outputCanonical) !== 'out') {
    throw new Error('Preload publication directories are unsafe')
  }
  const liveCanonical = await ensureRealDirectory(liveDirectory)
  const outerCanonical = await ensureRealDirectory(outerIntermediateDirectory)
  if (
    dirname(liveCanonical) !== outputCanonical ||
    basename(liveCanonical) !== 'preload' ||
    dirname(outerCanonical) !== outputCanonical ||
    basename(outerCanonical) !== '.preload-outer'
  ) {
    throw new Error('Preload publication directories are unsafe')
  }

  return { liveDirectory, liveCanonical, outerIntermediateDirectory, outputDirectory }
}

async function runSerialized<Result>(
  key: string,
  operation: () => Promise<Result>
): Promise<Result> {
  const previous = publicationQueues.get(key) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(operation)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  publicationQueues.set(key, tail)
  try {
    return await run
  } finally {
    if (publicationQueues.get(key) === tail) publicationQueues.delete(key)
  }
}

async function stagedArtifacts(stagingDirectory: string): Promise<GeneratedArtifact[]> {
  const entries = await readdir(stagingDirectory, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error('Staged preload output contains unexpected artifacts')
  }
  const names = entries.map(({ name }) => name).sort()
  const hasMaps = names.includes('index.js.map') || names.includes('plugin.js.map')
  const expected: GeneratedArtifact[] = hasMaps
    ? ['index.js', 'index.js.map', 'plugin.js', 'plugin.js.map']
    : ['index.js', 'plugin.js']
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error('Staged preload output is incomplete')
  }
  return expected
}

async function removeOwnedPath(path: string, allowDirectory = false): Promise<void> {
  const metadata = await optionalLstat(path)
  if (!metadata) return
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    if (!allowDirectory) throw new Error('Preload publication artifact is unsafe')
    await rm(path, { recursive: true })
    return
  }
  await rm(path, { force: true })
}

async function removeOwnedDirectory(path: string): Promise<void> {
  const metadata = await optionalLstat(path)
  if (!metadata) return
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Preload cleanup directory is unsafe')
  }
  await rm(path, { recursive: true })
}

async function replaceFileAtomically(
  source: string,
  destination: string,
  displaced: string
): Promise<void> {
  try {
    await rename(source, destination)
    return
  } catch (initialError) {
    const destinationMetadata = await optionalLstat(destination)
    if (!destinationMetadata) throw initialError
    if (destinationMetadata.isSymbolicLink() || !destinationMetadata.isFile()) {
      throw new Error('Preload publication artifact is unsafe')
    }
    await rename(destination, displaced)
    try {
      await rename(source, destination)
    } catch (replacementError) {
      try {
        await rename(displaced, destination)
      } catch {
        throw new Error('Preload atomic replacement recovery failed')
      }
      throw replacementError
    }
    await removeOwnedPath(displaced)
  }
}

async function prepareArtifacts(
  stagingDirectory: string,
  liveDirectory: string,
  desiredArtifacts: readonly GeneratedArtifact[],
  token: string
): Promise<ArtifactRecord[]> {
  const records: ArtifactRecord[] = []
  for (const artifact of GENERATED_ARTIFACTS) {
    const live = join(liveDirectory, artifact)
    const metadata = await optionalLstat(live)
    if (metadata && (metadata.isSymbolicLink() || !metadata.isFile())) {
      throw new Error('Preload publication artifact is unsafe')
    }
    const record: ArtifactRecord = {
      artifact,
      live,
      ready: join(liveDirectory, `.${artifact}.${token}.ready`),
      backup: join(liveDirectory, `.${artifact}.${token}.backup`),
      rollback: join(liveDirectory, `.${artifact}.${token}.rollback`),
      displaced: join(liveDirectory, `.${artifact}.${token}.displaced`),
      existed: metadata !== null
    }
    records.push(record)
    if (record.existed) await copyFile(record.live, record.backup)
  }
  for (const record of records) {
    if (desiredArtifacts.includes(record.artifact)) {
      await copyFile(join(stagingDirectory, record.artifact), record.ready)
    }
  }
  return records
}

async function cleanupOwnedArtifacts(records: readonly ArtifactRecord[]): Promise<void> {
  await Promise.all(
    records
      .flatMap((record) => [record.ready, record.backup, record.rollback, record.displaced])
      .map((path) => removeOwnedPath(path))
  )
}

async function rollbackArtifacts(
  records: readonly ArtifactRecord[],
  replaceFile: ReplaceFile
): Promise<boolean> {
  let complete = true
  for (const record of records) {
    try {
      if (record.existed) {
        await copyFile(record.backup, record.rollback)
        await replaceFile(record.rollback, record.live, record.displaced)
      } else {
        await removeOwnedPath(record.live)
      }
    } catch {
      complete = false
    }
  }
  return complete
}

async function publishArtifacts(
  stagingDirectory: string,
  liveDirectory: string,
  desiredArtifacts: readonly GeneratedArtifact[],
  replaceFile: ReplaceFile
): Promise<void> {
  const records = await prepareArtifacts(
    stagingDirectory,
    liveDirectory,
    desiredArtifacts,
    basename(stagingDirectory)
  )
  let publicationStarted = false
  let preserveOwnedArtifacts = false
  try {
    for (const record of records) {
      if (!desiredArtifacts.includes(record.artifact)) continue
      publicationStarted = true
      await replaceFile(record.ready, record.live, record.displaced)
    }
    for (const record of records) {
      if (desiredArtifacts.includes(record.artifact)) continue
      await removeOwnedPath(record.live)
    }
  } catch (error) {
    if (publicationStarted) {
      const rollbackComplete = await rollbackArtifacts(records, replaceFile)
      if (!rollbackComplete) {
        preserveOwnedArtifacts = true
        throw new Error('Preload publication failed and rollback was incomplete')
      }
    }
    throw error
  } finally {
    if (!preserveOwnedArtifacts) await cleanupOwnedArtifacts(records)
  }
}

async function cleanupLegacyChunks(liveDirectory: string): Promise<void> {
  await removeOwnedPath(join(liveDirectory, 'chunks'), true)
}

async function buildPublishTransaction(
  options: BuildAndPublishPreloadsOptions,
  directories: ValidatedDirectories
): Promise<void> {
  const stagingDirectory = await mkdtemp(join(directories.outputDirectory, '.preload-stage-'))
  let failure: unknown
  try {
    for (const entry of PRELOAD_ENTRIES) {
      await options.buildEntry(entry, stagingDirectory)
    }
    const artifacts = await stagedArtifacts(stagingDirectory)
    await publishArtifacts(
      stagingDirectory,
      directories.liveDirectory,
      artifacts,
      options.replaceFile ?? replaceFileAtomically
    )
    await cleanupLegacyChunks(directories.liveDirectory)
  } catch (error) {
    failure = error
  }

  try {
    await removeOwnedDirectory(stagingDirectory)
    await removeOwnedDirectory(directories.outerIntermediateDirectory)
  } catch (cleanupError) {
    if (!failure) failure = cleanupError
  }
  if (failure) throw failure
}

export async function buildAndPublishPreloads(
  options: BuildAndPublishPreloadsOptions
): Promise<void> {
  const initialDirectories = await validateDirectories(options)
  return runSerialized(initialDirectories.liveCanonical, async () => {
    const directories = await validateDirectories(options)
    if (directories.liveCanonical !== initialDirectories.liveCanonical) {
      throw new Error('Preload publication directories are unsafe')
    }
    await buildPublishTransaction(options, directories)
  })
}
