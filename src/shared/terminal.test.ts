import { describe, expect, it } from 'vitest'
import { terminalCommandSchema } from './terminal'

describe('user terminal command boundary', () => {
  it('requires complete capabilities and rejects malformed dimensions and exact byte overflows', () => {
    const cap = {
      projectPath: '/tmp/project',
      terminalId: '00000000-0000-4000-8000-000000000001',
      generation: '00000000-0000-4000-8000-000000000002',
      connectionEpoch: 1
    }
    for (const type of ['attach', 'input', 'resize', 'ack', 'close'])
      expect(terminalCommandSchema.safeParse({ type, projectPath: '/tmp/project' }).success).toBe(
        false
      )
    for (const cols of [0, -1, 1.5, Infinity, NaN, 501])
      expect(
        terminalCommandSchema.safeParse({ type: 'resize', ...cap, cols, rows: 24 }).success
      ).toBe(false)
    expect(
      terminalCommandSchema.safeParse({
        type: 'input',
        ...cap,
        encoding: 'binary',
        data: '\xff'.repeat(16384)
      }).success
    ).toBe(true)
    expect(
      terminalCommandSchema.safeParse({
        type: 'input',
        ...cap,
        encoding: 'binary',
        data: '\xff'.repeat(16385)
      }).success
    ).toBe(false)
    expect(
      terminalCommandSchema.safeParse({ type: 'input', ...cap, data: '中'.repeat(5462) }).success
    ).toBe(false)
    expect(
      terminalCommandSchema.safeParse({ type: 'input', ...cap, encoding: 'binary', data: '中' })
        .success
    ).toBe(false)
  })
  it('accepts a narrow create and rejects renderer-controlled launch authority', () => {
    expect(
      terminalCommandSchema.safeParse({
        type: 'create',
        projectPath: '/tmp/project',
        cols: 80,
        rows: 24
      }).success
    ).toBe(true)
    for (const extra of [
      { shell: '/bin/sh' },
      { env: {} },
      { pid: 1 },
      { cwd: '/' },
      { args: [] }
    ]) {
      expect(
        terminalCommandSchema.safeParse({
          type: 'create',
          projectPath: '/tmp/project',
          cols: 80,
          rows: 24,
          ...extra
        }).success
      ).toBe(false)
    }
  })
})
