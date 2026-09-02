import { resolve } from 'node:path'

export type PreloadBuildPlanSettings = {
  root: string
  mode: string
  sourcemap: boolean | 'inline' | 'hidden'
  minify: boolean | 'esbuild' | 'terser'
}

export type PreloadBuildPlan = {
  entry: 'index' | 'plugin'
  input: string
  outDir: string
  emptyOutDir: boolean
  mode: string
  sourcemap: PreloadBuildPlanSettings['sourcemap']
  minify: PreloadBuildPlanSettings['minify']
}

export function createPreloadBuildPlans(
  settings: PreloadBuildPlanSettings,
  outputDirectory: string
): PreloadBuildPlan[] {
  return (['index', 'plugin'] as const).map((entry, index) => ({
    entry,
    input: resolve(settings.root, `src/preload/${entry}.ts`),
    outDir: outputDirectory,
    emptyOutDir: index === 0,
    mode: settings.mode,
    sourcemap: settings.sourcemap,
    minify: settings.minify
  }))
}
