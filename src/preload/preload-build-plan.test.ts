import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPreloadBuildPlans } from './preload-build-plan'

describe('self-contained preload build plans', () => {
  it('cleans preload output once and then writes both entries without outer artifacts', () => {
    const root = '/workspace/pi-desktop'
    const stagingDirectory = resolve(root, 'out/.preload-stage-test')

    expect(
      createPreloadBuildPlans(
        {
          root,
          mode: 'production',
          sourcemap: false,
          minify: false
        },
        stagingDirectory
      )
    ).toEqual([
      {
        entry: 'index',
        input: resolve(root, 'src/preload/index.ts'),
        outDir: stagingDirectory,
        emptyOutDir: true,
        mode: 'production',
        sourcemap: false,
        minify: false
      },
      {
        entry: 'plugin',
        input: resolve(root, 'src/preload/plugin.ts'),
        outDir: stagingDirectory,
        emptyOutDir: false,
        mode: 'production',
        sourcemap: false,
        minify: false
      }
    ])
  })

  it('propagates resolved mode, sourcemap, and minify settings to both nested builds', () => {
    const plans = createPreloadBuildPlans(
      {
        root: '/workspace/pi-desktop',
        mode: 'development',
        sourcemap: 'hidden',
        minify: 'terser'
      },
      '/workspace/pi-desktop/out/.preload-stage-test'
    )

    expect(plans.map(({ mode, sourcemap, minify }) => ({ mode, sourcemap, minify }))).toEqual([
      { mode: 'development', sourcemap: 'hidden', minify: 'terser' },
      { mode: 'development', sourcemap: 'hidden', minify: 'terser' }
    ])
  })
})
