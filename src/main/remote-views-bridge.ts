import {
  remoteBrowserInputSchema,
  remoteTerminalInputSchema,
  type RemoteViewAccess,
  type RemoteViewSummary
} from '../shared/remote-views'
import type { MobileViewsBridge } from './mobile-gateway'
import type { MobilePluginViews } from './mobile-plugin-views'
import type { RemoteBrowser } from './remote-browser'
import type { RemoteTerminals } from './remote-terminals'
import { t } from '../shared/i18n'

const TERMINAL = 'terminal:'

/** One remote-view surface for the phone over the browser and terminal plugins. */
export function createRemoteViewsBridge(options: {
  access(): RemoteViewAccess
  browser(): RemoteBrowser | null
  browserEnabled(): boolean
  browserSummary(): { detail?: string; live: boolean }
  terminals: RemoteTerminals
  terminalEnabled(): boolean
  plugins?: MobilePluginViews
}): MobileViewsBridge {
  const invalid = (): never => {
    throw new Error(t('请求参数无效'))
  }
  return {
    access: options.access,
    ...(options.plugins ? { plugins: options.plugins } : {}),
    list: () => {
      const views: RemoteViewSummary[] = []
      if (options.browserEnabled() && options.browser())
        views.push({
          id: 'browser',
          kind: 'browser',
          title: t('浏览器'),
          ...options.browserSummary()
        })
      if (options.terminalEnabled()) views.push(...options.terminals.list())
      return views
    },
    subscribe: (id, send) => {
      if (id === 'browser') {
        const browser = options.browserEnabled() ? options.browser() : null
        return browser ? browser.subscribe((event, data) => send(event, data)) : null
      }
      if (id.startsWith(TERMINAL) && options.terminalEnabled())
        return options.terminals.subscribe(id.slice(TERMINAL.length), (event) =>
          send(event.type, event)
        )
      return null
    },
    input: async (id, value) => {
      if (id === 'browser') {
        const browser = options.browserEnabled() ? options.browser() : null
        if (!browser) throw new Error(t('浏览器插件已关闭'))
        const parsed = remoteBrowserInputSchema.safeParse(value)
        return parsed.success ? browser.input(parsed.data) : invalid()
      }
      if (id.startsWith(TERMINAL) && options.terminalEnabled()) {
        const parsed = remoteTerminalInputSchema.safeParse(value)
        return parsed.success
          ? options.terminals.input(id.slice(TERMINAL.length), parsed.data)
          : invalid()
      }
      throw new Error(t('这个视图不存在或已关闭'))
    }
  }
}
