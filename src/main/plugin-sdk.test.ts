import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PLUGIN_HOST_METHODS } from '../shared/plugin-api'
import { PLUGIN_TEMPLATES } from '../shared/plugin-install'
import { scaffoldPlugin } from './plugin-scaffold'
import { discoverWorkbenchManifests, workbenchManifestSchema } from './workbench-manifest'

const sdk = resolve('resources/plugin-sdk')
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** Type errors of a plugin folder checked through its own `jsconfig.json`. */
function typeErrors(folder: string): string[] {
  const config = ts.readConfigFile(join(folder, 'jsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, folder)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  return ts
    .getPreEmitDiagnostics(program)
    .map(
      (diagnostic) =>
        `${diagnostic.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
    )
}

describe('plugin SDK', () => {
  it('ships the manifest JSON Schema generated from the manifest validator', async () => {
    const schema = `${JSON.stringify(
      z.toJSONSchema(workbenchManifestSchema, { io: 'input', unrepresentable: 'any' }),
      null,
      2
    )}\n`
    const file = join(sdk, 'pi-desktop.schema.json')
    // UPDATE_PLUGIN_SDK=1 npm test -- plugin-sdk regenerates it.
    if (process.env.UPDATE_PLUGIN_SDK) await writeFile(file, schema)
    // Windows checkouts may turn line endings into CRLF.
    expect((await readFile(file, 'utf8')).replace(/\r\n/g, '\n')).toBe(schema)
  })

  it('types every host method a plugin can call', async () => {
    const types = await readFile(join(sdk, 'pi-desktop.d.ts'), 'utf8')
    // Bound to process-side helpers with their own signatures in `ProcessApi`.
    const processOnly: Record<string, string> = {
      'commands.register': 'register(command',
      'commands.unregister': 'unregister(id',
      'agent.registerTool': 'registerTool(tool',
      'agent.unregisterTool': 'unregisterTool(name',
      'plugin.setSettings': 'setSettings(values',
      'plugin.getDataPath': 'getDataPath()'
    }
    for (const method of Object.keys(PLUGIN_HOST_METHODS))
      expect(types, method).toContain(processOnly[method] ?? `'${method}':`)
  })

  it.each(PLUGIN_TEMPLATES)(
    'the %s template becomes a plugin that loads and type-checks',
    async (template) => {
      const parent = await mkdtemp(join(tmpdir(), 'pi-plugin-sdk-'))
      roots.push(parent)
      const folder = await scaffoldPlugin({
        sdkDirectory: sdk,
        parentPath: parent,
        template,
        id: 'acme.sample-plugin',
        name: 'Sample Plugin',
        appVersion: '0.3.0-nightly.4'
      })
      expect(folder).toBe(join(parent, 'sample-plugin'))
      const manifest = JSON.parse(await readFile(join(folder, 'pi-desktop.json'), 'utf8'))
      expect(manifest).toMatchObject({
        id: 'acme.sample-plugin',
        name: 'Sample Plugin',
        engines: { piDesktop: '>=0.3.0' }
      })
      const discovery = await discoverWorkbenchManifests({
        roots: [{ path: folder, source: 'test', scope: 'user', hasExecutablePiResources: false }],
        appVersion: '0.3.0'
      })
      expect(discovery.diagnostics).toEqual([])
      expect(discovery.plugins.map((plugin) => plugin.pluginId)).toEqual(['acme.sample-plugin'])
      expect(typeErrors(folder)).toEqual([])

      await expect(
        scaffoldPlugin({
          sdkDirectory: sdk,
          parentPath: parent,
          template,
          id: 'other.sample-plugin',
          name: 'Again',
          appVersion: '0.3.0'
        })
      ).rejects.toThrow(/已存在/)
    },
    30_000
  )

  it('ships examples that load without problems and type-check', async () => {
    const examples = resolve('examples/plugins')
    const folders = (await readdir(examples, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(examples, entry.name))
    expect(folders.length).toBeGreaterThanOrEqual(2)
    const discovery = await discoverWorkbenchManifests({
      roots: folders.map((path) => ({
        path,
        source: 'example',
        scope: 'user' as const,
        hasExecutablePiResources: false
      })),
      appVersion: '0.1.0'
    })
    expect(discovery.diagnostics).toEqual([])
    expect(discovery.plugins).toHaveLength(folders.length)
    expect(typeErrors(examples)).toEqual([])
  }, 30_000)

  it('catches a wrong call to the plugin API', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'pi-plugin-sdk-'))
    roots.push(parent)
    const folder = await scaffoldPlugin({
      sdkDirectory: sdk,
      parentPath: parent,
      template: 'command',
      id: 'acme.wrong',
      name: 'Wrong',
      appVersion: '0.1.0'
    })
    await writeFile(
      join(folder, 'main.js'),
      '// @ts-check\nmodule.exports = { onLoad: () => pi.fs.readText(42) }\n'
    )
    expect(typeErrors(folder).join('\n')).toMatch(/number.*string/)
  }, 30_000)
})
