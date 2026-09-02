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
  liveIdentity: DirectoryIdentity
  outerIntermediateDirectory: string
  outputDirectory: string
  outputIdentity: DirectoryIdentity
}

type DirectoryIdentity = {
  canonical: string
  dev: number | bigint
  ino: number | bigint
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

class PreloadDirectoryIdentityError extends Error {
  constructor(readonly stageMayBeCleaned: boolean) {
    super('Preload publication directory identity changed')
  }
}

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

async function realDirectoryIdentity(
  path: string,
  createIfMissing: boolean
): Promise<DirectoryIdentity> {
  let metadata = await optionalLstat(path)
  if (!metadata && createIfMissing) {
    await mkdir(path)
    metadata = await lstat(path)
  }
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Preload publication directories are unsafe')
  }
  return {
    canonical: await realpath(path),
    dev: metadata.dev,
    ino: metadata.ino
  }
}

function hasSameIdentity(current: DirectoryIdentity, expected: DirectoryIdentity): boolean {
  return (
    current.canonical === expected.canonical &&
    current.dev === expected.dev &&
    current.ino === expected.ino
  )
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
  const outputIdentity = await realDirectoryIdentity(outputDirectory, true)
  if (
    dirname(outputIdentity.canonical) !== rootCanonical ||
    basename(outputIdentity.canonical) !== 'out'
  ) {
    throw new Error('Preload publication directories are unsafe')
  }
  const liveIdentity = await realDirectoryIdentity(liveDirectory, true)
  const outerIdentity = await realDirectoryIdentity(outerIntermediateDirectory, true)
  if (
    dirname(liveIdentity.canonical) !== outputIdentity.canonical ||
    basename(liveIdentity.canonical) !== 'preload' ||
    dirname(outerIdentity.canonical) !== outputIdentity.canonical ||
    basename(outerIdentity.canonical) !== '.preload-outer'
  ) {
    throw new Error('Preload publication directories are unsafe')
  }

  return {
    liveDirectory,
    liveCanonical: liveIdentity.canonical,
    liveIdentity,
    outerIntermediateDirectory,
    outputDirectory,
    outputIdentity
  }
}

async function verifyPostBuildIdentity(directories: ValidatedDirectories): Promise<void> {
  let outputIdentity: DirectoryIdentity
  try {
    outputIdentity = await realDirectoryIdentity(directories.outputDirectory, false)
  } catch {
    throw new PreloadDirectoryIdentityError(false)
  }
  if (!hasSameIdentity(outputIdentity, directories.outputIdentity)) {
    throw new PreloadDirectoryIdentityError(false)
  }

  let liveIdentity: DirectoryIdentity
  try {
    liveIdentity = await realDirectoryIdentity(directories.liveDirectory, false)
  } catch {
    throw new PreloadDirectoryIdentityError(true)
  }
  if (!hasSameIdentity(liveIdentity, directories.liveIdentity)) {
    throw new PreloadDirectoryIdentityError(true)
  }

  // Local desktop trust boundary: the filesystem can still change after this no-follow check.
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
  const records: ArtifactRecord[] = GENERATED_ARTIFACTS.map((artifact) => {
    const live = join(liveDirectory, artifact)
    return {
      artifact,
      live,
      ready: join(liveDirectory, `.${artifact}.${token}.ready`),
      backup: join(liveDirectory, `.${artifact}.${token}.backup`),
      rollback: join(liveDirectory, `.${artifact}.${token}.rollback`),
      displaced: join(liveDirectory, `.${artifact}.${token}.displaced`),
      existed: false
    }
  })

  try {
    for (const record of records) {
      const metadata = await optionalLstat(record.live)
      if (metadata && (metadata.isSymbolicLink() || !metadata.isFile())) {
        throw new Error('Preload publication artifact is unsafe')
      }
      record.existed = metadata !== null
      if (record.existed) await copyFile(record.live, record.backup)
    }
    for (const record of records) {
      if (desiredArtifacts.includes(record.artifact)) {
        await copyFile(join(stagingDirectory, record.artifact), record.ready)
      }
    }
    return records
  } catch (error) {
    await cleanupOwnedArtifacts(records)
    throw error
  }
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
    await verifyPostBuildIdentity(directories)
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
    const identityFailure = failure instanceof PreloadDirectoryIdentityError ? failure : undefined
    if (!identityFailure || identityFailure.stageMayBeCleaned) {
      await removeOwnedDirectory(stagingDirectory)
    }
    if (!identityFailure) await removeOwnedDirectory(directories.outerIntermediateDirectory)
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
    if (
      !hasSameIdentity(directories.outputIdentity, initialDirectories.outputIdentity) ||
      !hasSameIdentity(directories.liveIdentity, initialDirectories.liveIdentity)
    ) {
      throw new PreloadDirectoryIdentityError(false)
    }
    await buildPublishTransaction(options, directories)
  })
}
