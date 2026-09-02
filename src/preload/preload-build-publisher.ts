import { copyFile, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const PRELOAD_ENTRIES = ['index', 'plugin'] as const
type PreloadEntry = (typeof PRELOAD_ENTRIES)[number]

type BuildAndPublishPreloadsOptions = {
  liveDirectory: string
  outerIntermediateDirectory: string
  buildEntry(entry: PreloadEntry, stagingDirectory: string): Promise<void>
}

function assertSafeDirectories(liveDirectory: string, outerIntermediateDirectory: string): void {
  const resolvedLive = resolve(liveDirectory)
  const resolvedOuter = resolve(outerIntermediateDirectory)
  const outputDirectory = dirname(resolvedLive)
  if (
    !isAbsolute(liveDirectory) ||
    !isAbsolute(outerIntermediateDirectory) ||
    basename(resolvedLive) !== 'preload' ||
    basename(outputDirectory) !== 'out' ||
    dirname(resolvedOuter) !== outputDirectory ||
    basename(resolvedOuter) !== '.preload-outer'
  ) {
    throw new Error('Preload publication directories are unsafe')
  }
}

async function stagedArtifacts(stagingDirectory: string): Promise<string[]> {
  const entries = await readdir(stagingDirectory, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error('Staged preload output contains unexpected artifacts')
  }
  const names = entries.map(({ name }) => name).sort()
  const hasMaps = names.includes('index.js.map') || names.includes('plugin.js.map')
  const expected = hasMaps
    ? ['index.js', 'index.js.map', 'plugin.js', 'plugin.js.map']
    : ['index.js', 'plugin.js']
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error('Staged preload output is incomplete')
  }
  return expected
}

async function replaceFileWithoutUnlinking(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination)
  } catch {
    // Some platforms cannot atomically replace an open file; retain the destination until copy.
    await copyFile(source, destination)
    await rm(source, { force: true })
  }
}

async function publishArtifacts(
  stagingDirectory: string,
  liveDirectory: string,
  artifacts: readonly string[]
): Promise<void> {
  await mkdir(liveDirectory, { recursive: true })
  const token = basename(stagingDirectory)
  const readyFiles = artifacts.map((artifact) => ({
    artifact,
    path: join(liveDirectory, `.${artifact}.${token}.ready`)
  }))

  try {
    for (const ready of readyFiles) {
      await copyFile(join(stagingDirectory, ready.artifact), ready.path)
    }
    for (const ready of readyFiles) {
      await replaceFileWithoutUnlinking(ready.path, join(liveDirectory, ready.artifact))
    }
  } finally {
    await Promise.all(readyFiles.map((ready) => rm(ready.path, { force: true })))
  }

  const retained = new Set(artifacts)
  for (const entry of await readdir(liveDirectory, { withFileTypes: true })) {
    if (retained.has(entry.name)) continue
    await rm(join(liveDirectory, entry.name), { recursive: entry.isDirectory(), force: true })
  }
}

export async function buildAndPublishPreloads(
  options: BuildAndPublishPreloadsOptions
): Promise<void> {
  assertSafeDirectories(options.liveDirectory, options.outerIntermediateDirectory)
  const outputDirectory = dirname(resolve(options.liveDirectory))
  await mkdir(outputDirectory, { recursive: true })
  const stagingDirectory = await mkdtemp(join(outputDirectory, '.preload-stage-'))

  try {
    for (const entry of PRELOAD_ENTRIES) {
      await options.buildEntry(entry, stagingDirectory)
    }
    const artifacts = await stagedArtifacts(stagingDirectory)
    await publishArtifacts(stagingDirectory, options.liveDirectory, artifacts)
  } finally {
    await Promise.all([
      rm(stagingDirectory, { recursive: true, force: true }),
      rm(options.outerIntermediateDirectory, { recursive: true, force: true })
    ])
  }
}
