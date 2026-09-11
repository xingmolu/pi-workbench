/** Codex remains listed even when disconnected so Settings can offer login. */
export function isCodexFamilyProvider(providerId: string): boolean {
  return providerId === 'openai-codex' || providerId.startsWith('openai-codex-')
}

/**
 * Composer accounts previously came only from Codex aliases and auth.json.
 * CLI models.json providers (including non-custom-* ids with embedded apiKey)
 * are usable for inference without an auth.json slot, so include them once the
 * runtime has available models. Settings read-only editing is unchanged.
 */
export function shouldProjectAccount(input: {
  providerId: string
  hasStoredCredential: boolean
  modelsJsonProvider: boolean
  runtimeAvailable: boolean
}): boolean {
  if (isCodexFamilyProvider(input.providerId) || input.hasStoredCredential) return true
  return input.modelsJsonProvider && input.runtimeAvailable
}

export function selectProjectedProviders<T extends { id: string }>(
  providers: readonly T[],
  ids: {
    stored: ReadonlySet<string>
    modelsJson: ReadonlySet<string>
    available: ReadonlySet<string>
  }
): T[] {
  return providers.filter((provider) =>
    shouldProjectAccount({
      providerId: provider.id,
      hasStoredCredential: ids.stored.has(provider.id),
      modelsJsonProvider: ids.modelsJson.has(provider.id),
      runtimeAvailable: ids.available.has(provider.id)
    })
  )
}
