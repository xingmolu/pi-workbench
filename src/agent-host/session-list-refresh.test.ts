import { describe, expect, it } from 'vitest'
import { SessionListRefresh } from './session-list-refresh'

function deferred() {
  let resolve!: (value: string[]) => void
  const promise = new Promise<string[]>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('SessionListRefresh', () => {
  it('does not overwrite a renamed list with an older same-generation result', async () => {
    const refresh = new SessionListRefresh()
    const older = deferred()
    const newer = deferred()
    const published: string[][] = []
    const first = refresh.run(
      4,
      () => 4,
      () => older.promise,
      (list) => published.push(list)
    )
    const second = refresh.run(
      4,
      () => 4,
      () => newer.promise,
      (list) => published.push(list)
    )
    newer.resolve(['new name'])
    expect(await second).toBe(true)
    older.resolve(['old name'])
    expect(await first).toBe(false)
    expect(published).toEqual([['new name']])
  })

  it('rejects a result after generation changes, even without another refresh', async () => {
    const refresh = new SessionListRefresh()
    const listed = deferred()
    let generation = 4
    const published: string[][] = []
    const pending = refresh.run(
      4,
      () => generation,
      () => listed.promise,
      (list) => published.push(list)
    )
    generation = 5
    listed.resolve(['stale'])
    expect(await pending).toBe(false)
    expect(published).toEqual([])
  })
})
