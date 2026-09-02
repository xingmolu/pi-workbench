import { resolve } from 'path'
import { builtinModules } from 'module'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { LogHandlerWithDefault, WarningHandlerWithDefault } from 'rollup'
import { build as viteBuild, type Plugin } from 'vite'

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
  return {
    name: 'self-contained-preloads',
    apply: 'build',
    async writeBundle() {
      for (const entry of ['index', 'plugin']) {
        await viteBuild({
          configFile: false,
          publicDir: false,
          build: {
            target: 'node22',
            outDir: resolve(__dirname, 'out/preload'),
            emptyOutDir: false,
            minify: false,
            reportCompressedSize: false,
            ssr: resolve(__dirname, `src/preload/${entry}.ts`),
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
                entryFileNames: `${entry}.js`,
                inlineDynamicImports: true
              }
            }
          },
          ssr: { noExternal: true }
        })
      }
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
          'electron-store-interop': resolve(__dirname, 'src/main/electron-store-interop.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), selfContainedPreloads()],
    build: {
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
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
