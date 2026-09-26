import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { checkSource } = require('./check-architecture.cjs')

it('rejects forbidden imports, reexports, dynamic imports and require with locations', () => {
  for (const statement of [
    "import fs from 'node:fs'",
    "export * from 'electron'",
    "import('@earendil-works/pi-ai')",
    "require('fs/promises')",
    "type X = import('electron').BrowserWindow",
    "import('node:fs', { with: { type: 'json' } })"
  ]) {
    const errors = checkSource(
      'src/renderer/src/example.ts',
      `// comment\n${statement}`,
      process.cwd()
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('src/renderer/src/example.ts:2:')
  }
})
it('resolves relative and tsconfig alias paths across process boundaries', () => {
  for (const specifier of ['../main/agent-runtime', '@renderer/../../main/agent-runtime']) {
    expect(
      checkSource('src/shared/example.ts', `export type { X } from '${specifier}'`, process.cwd())
    ).toHaveLength(1)
  }
})
it('allows neutral Node APIs, shared/own imports, and concrete Electron adapters', () => {
  for (const [file, source] of [
    ['src/main/session-worker-pool.ts', "import { randomUUID } from 'node:crypto'"],
    [
      'src/renderer/src/example.ts',
      "import type { X } from '../../shared/contracts'; import './view'"
    ],
    ['src/main/utility-session-worker.ts', "import { utilityProcess } from 'electron'"],
    ['src/preload/index.ts', "import { ipcRenderer } from 'electron'"],
    ['src/shared/example.test.ts', "import fs from 'node:fs'"],
    [
      'src/shared/example.ts',
      `const s = "import fs from 'node:fs'"; // require('electron')\n/* export * from 'electron' */`
    ]
  ])
    expect(checkSource(file, source, process.cwd())).toEqual([])
})
it('rejects Electron/SDK edges for neutral orchestration and SDK edges for Main', () => {
  expect(
    checkSource(
      'src/main/session-worker-pool.ts',
      "import type { X } from 'electron'",
      process.cwd()
    )
  ).toHaveLength(1)
  expect(
    checkSource(
      'src/main/index.ts',
      "import { X } from '@earendil-works/pi-coding-agent'",
      process.cwd()
    )
  ).toHaveLength(1)
})
