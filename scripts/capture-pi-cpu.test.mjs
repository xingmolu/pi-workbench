import { createRequire } from 'node:module'
import { test, expect } from 'vitest'

const require = createRequire(import.meta.url)
const { cpuSeconds, parseProcesses, selectTree, summarize } = require('./capture-pi-cpu.cjs')

test('parses macOS CPU time and restricts samples to the selected app tree', () => {
  expect(cpuSeconds('0:13.61')).toBe(13.61)
  expect(cpuSeconds('1:02:03.50')).toBe(3723.5)
  const rows = parseProcesses(`
10 1 0.0 1024 0:10.00 /Applications/Pi Desktop.app/Contents/MacOS/Pi Desktop
11 10 0.0 2048 0:05.00 /Applications/Pi Desktop.app/Contents/Frameworks/Helper --type=renderer --token=PRIVATE
12 11 0.0 1024 0:01.00 /Applications/Pi Desktop.app/Contents/Frameworks/Helper --type=utility --utility-sub-type=node.mojom.NodeService
20 1 0.0 2048 0:20.00 /Applications/Other.app/Contents/MacOS/Other
`)
  expect(selectTree(rows, 10).map((item) => item.pid)).toEqual([10, 11, 12])
  const later = rows.map((item) => ({
    ...item,
    cpuSeconds: item.pid === 11 ? item.cpuSeconds + 6 : item.cpuSeconds
  }))
  const report = summarize(later, 10, new Map(rows.map((item) => [item.pid, item.cpuSeconds])), 5)
  expect(report.totalCoreCpuPercent).toBe(120)
  expect(report.processes[0].role).toBe('renderer')
  expect(report.processes[0].coreCpuPercent).toBe(120)
  expect(JSON.stringify(report)).not.toContain('PRIVATE')
  expect(JSON.stringify(report)).not.toContain('/Applications/')
})
