import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AccountSummary,
  RuntimeAccounts,
  RuntimeConfigCommand
} from '../../../shared/contracts'

const ACTIVE_LOGIN = new Set(['starting', 'browser', 'device_code', 'waiting'])

/** A subscription row: who it is, which engine signs it in and uses it. */
export type SubscriptionRow = { runtimeId: string; engine: string; account: AccountSummary }
/** An API connection row, labelled with the engine that uses it. */
export type ApiRow = SubscriptionRow

export function subscriptionRows(engines: readonly RuntimeAccounts[]): SubscriptionRow[] {
  // Borrowed accounts are the lender's rows; the lender's row says who else may use them.
  return engines
    .filter((engine) => !engine.borrowsAccounts)
    .flatMap((engine) =>
      engine.accounts
        // An empty login slot (never signed in, no email) is not an account yet.
        .filter(
          (account) =>
            account.platform &&
            account.authType === 'oauth' &&
            (account.connected || account.email || account.alias)
        )
        .map((account) => ({ runtimeId: engine.runtimeId, engine: engine.label, account }))
    )
}

export function apiRows(engines: readonly RuntimeAccounts[], runtimeId: string): ApiRow[] {
  return engines
    .filter((engine) => engine.runtimeId === runtimeId)
    .flatMap((engine) =>
      engine.accounts
        .filter((account) => account.authType === 'api_key')
        .map((account) => ({ runtimeId: engine.runtimeId, engine: engine.label, account }))
    )
}

export function loginInProgress(engines: readonly RuntimeAccounts[]): boolean {
  return engines.some(
    (engine) => ACTIVE_LOGIN.has(engine.login.phase) || engine.binary?.state === 'downloading'
  )
}

/**
 * Every engine's accounts as Settings shows them, independent of the open chat. Reloads
 * after each command and keeps polling while a sign-in waits on the browser.
 */
export function useRuntimeAccounts(): {
  engines: RuntimeAccounts[] | null
  error: string
  pending: string | null
  reload: () => Promise<void>
  run: (runtimeId: string, command: RuntimeConfigCommand, key?: string) => Promise<boolean>
} {
  const [engines, setEngines] = useState<RuntimeAccounts[] | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const mounted = useRef(true)
  const reload = useCallback(async () => {
    try {
      const next = await window.pi.runtimeAccounts()
      if (mounted.current) setEngines(next)
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    void reload()
    return () => {
      mounted.current = false
    }
  }, [reload])
  const polling = engines ? loginInProgress(engines) : false
  useEffect(() => {
    if (!polling) return
    const timer = setInterval(() => void reload(), 1200)
    return () => clearInterval(timer)
  }, [polling, reload])
  const run = useCallback(
    async (runtimeId: string, command: RuntimeConfigCommand, key: string = command.type) => {
      setPending(key)
      setError('')
      try {
        await window.pi.runtimeConfig(runtimeId, command)
        return true
      } catch (reason) {
        if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
        return false
      } finally {
        if (mounted.current) setPending(null)
        await reload()
      }
    },
    [reload]
  )
  return { engines, error, pending, reload, run }
}
