import { resolve } from 'path'
import { builtinModules } from 'module'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { LogHandlerWithDefault, WarningHandlerWithDefault } from 'rollup'
import { build as viteBuild, type Plugin } from 'vite'
import {
  createPreloadBuildPlans,
  type PreloadBuildPlanSettings
} from './src/preload/preload-build-plan'
import { buildAndPublishPreloads } from './src/preload/preload-build-publisher'

const preloadWarningHandler: WarningHandlerWithDefault = (warning, defaultHandler) => {
  if (warning.code === 'INVALID_ANNOTATION' && warning.id?.includes('/node_modules/zod/')) return
  defaultHandler(warning)
}

const preloadLogHandler: LogHandlerWithDefault = (level, log, defaultHandler) => {
  if (
    level === 'warn' &&
    log.code === 'INVALID_ANNOTATION' &&
    log.id?.includes('/node_modules/zod/')
  ) {
    return
  }
  defaultHandler(level, log)
}

function selfContainedPreloads(): Plugin {
  let settings: PreloadBuildPlanSettings | undefined

  return {
    name: 'self-contained-preloads',
    apply: 'build',
    configResolved(config) {
      settings = {
        root: config.root,
        mode: config.mode,
        sourcemap: config.build.sourcemap,
        minify: config.build.minify
      }
    },
    async writeBundle() {
      if (!settings) throw new Error('Preload build configuration is unavailable')
      const resolvedSettings = settings

      // Electron Vite watch calls writeBundle after each outer rebuild, rebuilding both sandboxes.
      await buildAndPublishPreloads({
        rootDirectory: resolvedSettings.root,
        liveDirectory: resolve(resolvedSettings.root, 'out/preload'),
        outerIntermediateDirectory: resolve(resolvedSettings.root, 'out/.preload-outer'),
        async buildEntry(entry, stagingDirectory) {
          const plan = createPreloadBuildPlans(resolvedSettings, stagingDirectory).find(
            (candidate) => candidate.entry === entry
          )
          if (!plan) throw new Error('Preload build entry is unavailable')
          await viteBuild({
            configFile: false,
            mode: plan.mode,
            publicDir: false,
            build: {
              target: 'node22',
              outDir: plan.outDir,
              emptyOutDir: plan.emptyOutDir,
              minify: plan.minify,
              sourcemap: plan.sourcemap,
              reportCompressedSize: false,
              ssr: plan.input,
              rollupOptions: {
                onLog: preloadLogHandler,
                onwarn: preloadWarningHandler,
                external: [
                  'electron',
                  /^electron\/.+/,
                  ...builtinModules.flatMap((module) => [module, `node:${module}`])
                ],
                output: {
                  format: 'cjs',
                  entryFileNames: `${plan.entry}.js`,
                  inlineDynamicImports: true
                }
              }
            },
            ssr: { noExternal: true }
          })
        }
      })
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        onLog: preloadLogHandler,
        onwarn: preloadWarningHandler,
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'agent-host': resolve(__dirname, 'src/agent-host/index.ts'),
          'terminal-host': resolve(__dirname, 'src/terminal-host/index.ts'),
          'plugin-host': resolve(__dirname, 'src/plugin-host/index.ts'),
          'browser-targets': resolve(__dirname, 'src/main/browser-targets.ts'),
          'browser-manager': resolve(__dirname, 'src/main/browser-manager.ts'),
          'electron-store-interop': resolve(__dirname, 'src/main/electron-store-interop.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), selfContainedPreloads()],
    build: {
      outDir: resolve(__dirname, 'out/.preload-outer'),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          plugin: resolve(__dirname, 'src/preload/plugin.ts')
        }
      }
    }
  },
  renderer: {
    server: {
      host: '127.0.0.1',
      port: 43123,
      strictPort: true
    },
    resolve: {
      alias: [
        { find: '@renderer', replacement: resolve('src/renderer/src') },
        { find: /^shiki$/, replacement: resolve('src/renderer/src/lib/shiki-bundle.ts') }
      ]
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        // The phone page is a second entry, served by the mobile gateway from out/renderer.
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          mobile: resolve(__dirname, 'src/renderer/mobile.html')
        }
      }
    }
  }
})
