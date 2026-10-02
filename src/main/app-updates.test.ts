import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { AppUpdates, type Updater } from './app-updates'

function fake(behaviour: (updater: FakeUpdater) => Promise<unknown>) {
  class FakeUpdater extends EventEmitter {
    autoDownload = true
    autoInstallOnAppQuit = true
    allowPrerelease = false
    feed: Record<string, unknown> | undefined
    installed = false
    setFeedURL(options: Record<string, unknown>): void {
      this.feed = options
    }
    checkForUpdates(): Promise<unknown> {
      return behaviour(this)
    }
    async downloadUpdate(): Promise<unknown> {
      this.emit('download-progress', { percent: 42.4 })
      this.emit('update-downloaded', { version: '0.1.0-nightly.9' })
      return []
    }
    quitAndInstall(): void {
      this.installed = true
    }
  }
  return new FakeUpdater()
}
type FakeUpdater = ReturnType<typeof fake>

function setup(
  options: Partial<ConstructorParameters<typeof AppUpdates>[0]> & { updater: () => Updater }
) {
  let token: string | undefined
  const opened: string[] = []
  const updates = new AppUpdates({
    version: '0.1.0-nightly.7',
    platform: 'win32',
    packaged: true,
    token: { read: () => token, write: (value) => (token = value) },
    openExternal: (url) => opened.push(url),
    onChange: () => undefined,
    ...options
  })
  return { updates, opened, token: () => token }
}

it('downloads and installs a newer nightly in place on Windows', async () => {
  const updater = fake(async (self) => {
    self.emit('update-available', { version: '0.1.0-nightly.9' })
    return {}
  })
  const { updates } = setup({ updater: () => updater })
  const found = await updates.handle({ type: 'check' })
  expect(found).toMatchObject({
    state: 'available',
    next: '0.1.0-nightly.9',
    channel: 'nightly',
    install: 'auto'
  })
  expect(updater).toMatchObject({ allowPrerelease: true, autoDownload: true })
  expect(updater.feed).toMatchObject({ provider: 'github', owner: 'xingmolu', repo: 'pi-desktop' })
  expect(await updates.handle({ type: 'download' })).toMatchObject({
    state: 'ready',
    next: '0.1.0-nightly.9'
  })
  // A later check leaves the downloaded update alone.
  expect(await updates.handle({ type: 'check' })).toMatchObject({ state: 'ready' })
  await updates.handle({ type: 'install' })
  expect(updater.installed).toBe(true)
})

it('sends macOS users to the release page instead of installing an unsigned build', async () => {
  const updater = fake(async (self) => {
    self.emit('update-available', { version: '0.1.0-nightly.9' })
    return {}
  })
  const { updates, opened } = setup({ platform: 'darwin', updater: () => updater })
  expect(await updates.handle({ type: 'check' })).toMatchObject({
    state: 'available',
    install: 'manual'
  })
  expect(updater.autoDownload).toBe(false)
  await updates.handle({ type: 'download' })
  expect(opened).toEqual(['https://github.com/xingmolu/pi-desktop/releases/tag/v0.1.0-nightly.9'])
})

it('asks for a token when the private repository hides its releases, then uses it', async () => {
  const feeds: Record<string, unknown>[] = []
  const make = vi.fn(() => {
    const updater = fake(async (self) => {
      feeds.push(self.feed!)
      if (!self.feed?.token) throw new Error('HttpError: 404 Not Found')
      return {}
    })
    return updater
  })
  const { updates, token } = setup({ updater: make })
  expect(await updates.handle({ type: 'check' })).toMatchObject({
    state: 'needs-token',
    hasToken: false
  })
  await expect(updates.handle({ type: 'token:set', token: 'nope' })).rejects.toThrow('GitHub 令牌')
  const status = await updates.handle({ type: 'token:set', token: 'github_pat_' + 'a'.repeat(40) })
  expect(status).toMatchObject({ state: 'none', hasToken: true })
  expect(token()).toMatch(/^github_pat_/)
  expect(feeds.at(-1)).toMatchObject({ private: true, token: token() })
})

it('says when this kind of install cannot check for updates', async () => {
  const { updates } = setup({ platform: 'linux', updater: () => fake(async () => null) })
  expect(await updates.handle({ type: 'check' })).toMatchObject({ state: 'unsupported' })
})

it('does nothing in development builds', async () => {
  const updater = fake(async () => undefined)
  const { updates } = setup({ packaged: false, updater: () => updater })
  updates.start()
  expect(updates.status()).toMatchObject({ state: 'unsupported' })
})
