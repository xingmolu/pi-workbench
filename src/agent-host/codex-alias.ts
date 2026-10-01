import type { Provider } from '@earendil-works/pi-ai'

/** One extra login of an OAuth provider, as pi-multi-login stores it in pi-multi-login.json. */
export type AliasEntry = { base: string; suffix: string; name?: string }

/**
 * The same provider the pi-multi-login extension registers for an alias, built here so the
 * host can sign accounts in before a project session loads the extension.
 */
export function createAliasProvider(source: Provider, entry: AliasEntry): Provider {
  const oauth = source.auth.oauth
  if (!oauth) throw new Error(`provider "${source.id}" does not offer OAuth authentication`)
  const id = `${entry.base}-${entry.suffix}`
  const name = entry.name ?? `${source.name} (${entry.suffix})`
  const models = source.getModels().map((model) => ({ ...model, provider: id }))
  return {
    ...source,
    id,
    name,
    auth: { ...source.auth, oauth: { ...oauth, name } },
    getModels: () => models,
    refreshModels: undefined
  }
}
