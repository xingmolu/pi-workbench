import { randomUUID } from 'node:crypto'
import type { AccountSummary } from '../shared/contracts'
import {
  credentialRequestSchema,
  type ChatgptAccessToken,
  type CredentialGrant,
  type CredentialGrantDecision,
  type CredentialGrantPrompt,
  type SharedChatgptAccount
} from '../shared/engine-credentials'
import { t } from '../shared/i18n'

export type EngineCredentialOptions = {
  /** ChatGPT logins Pi holds. */
  accounts(): Promise<AccountSummary[]>
  /** A fresh access token for one of them, from Pi. */
  token(accountId: string): Promise<ChatgptAccessToken>
  /** Durable "always allow" decisions. */
  grants: { read(): CredentialGrant[]; write(grants: CredentialGrant[]): void }
  /** Shows the dialog; resolves with the user's choice. */
  ask(prompt: CredentialGrantPrompt): Promise<CredentialGrantDecision>
  label(runtimeId: string): string
}

/**
 * Lends Pi's ChatGPT logins to other engines. An engine sees the accounts, but receives a token
 * only after the user allowed it to use that account: once for this run of the app, or always.
 * Tokens are short-lived access tokens; refresh tokens stay with Pi.
 */
export class EngineCredentialBroker {
  /** "Allow once" lasts until the app quits. */
  private readonly session = new Set<string>()
  /** One dialog per (engine, account) at a time; concurrent requests share the answer. */
  private readonly asking = new Map<string, Promise<CredentialGrantDecision>>()

  constructor(private readonly options: EngineCredentialOptions) {}

  /** Handles a credential request from an engine host; false if the message is not one. */
  handle(runtimeId: string, message: unknown, reply: (message: unknown) => void): boolean {
    const parsed = credentialRequestSchema.safeParse(message)
    if (!parsed.success) return false
    const request = parsed.data
    const answer =
      request.kind === 'chatgpt-accounts'
        ? this.list(runtimeId)
        : this.token(runtimeId, request.accountId)
    void answer.then(
      (data) =>
        reply({ type: 'credential:response', requestId: request.requestId, ok: true, data }),
      (error: unknown) =>
        reply({
          type: 'credential:response',
          requestId: request.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
    )
    return true
  }

  private key(account: { id: string; email?: string }): string {
    // Emails survive re-adding an account under a new alias; ids are the fallback.
    return account.email?.toLowerCase() ?? account.id
  }

  private granted(runtimeId: string, account: { id: string; email?: string }): boolean {
    const key = this.key(account)
    return (
      this.session.has(`${runtimeId}\n${key}`) ||
      this.options.grants
        .read()
        .some((grant) => grant.runtimeId === runtimeId && grant.account === key)
    )
  }

  async list(runtimeId: string): Promise<SharedChatgptAccount[]> {
    const accounts = await this.options.accounts()
    return accounts
      .filter((account) => account.platform === 'chatgpt' && account.connected)
      .map((account) => ({
        id: account.id,
        ...(account.email ? { email: account.email } : {}),
        ...(account.plan ? { plan: account.plan } : {}),
        granted: this.granted(runtimeId, account)
      }))
  }

  async token(runtimeId: string, accountId: string): Promise<ChatgptAccessToken> {
    const account = (await this.options.accounts()).find(
      (item) => item.id === accountId && item.platform === 'chatgpt'
    )
    if (!account) throw new Error(t('这个 ChatGPT 账号已不在 Pi 中'))
    if (!this.granted(runtimeId, account)) {
      const key = `${runtimeId}\n${this.key(account)}`
      let pending = this.asking.get(key)
      if (!pending) {
        pending = this.options
          .ask({
            id: randomUUID(),
            runtimeId,
            runtimeLabel: this.options.label(runtimeId),
            accountId,
            ...(account.email ? { email: account.email } : {})
          })
          .finally(() => this.asking.delete(key))
        this.asking.set(key, pending)
      }
      const decision = await pending
      if (decision === 'deny')
        throw new Error(
          t('没有允许 {value} 使用这个账号', { value: this.options.label(runtimeId) })
        )
      if (decision === 'always') this.allow(runtimeId, this.key(account))
      else this.session.add(key)
    }
    return this.options.token(accountId)
  }

  allow(runtimeId: string, account: string): void {
    const grants = this.options.grants.read()
    if (grants.some((grant) => grant.runtimeId === runtimeId && grant.account === account)) return
    this.options.grants.write([...grants, { runtimeId, account }])
  }

  /** Every durable grant, for Settings. */
  grantList(): CredentialGrant[] {
    return this.options.grants.read()
  }

  revoke(runtimeId: string, account: string): void {
    this.session.delete(`${runtimeId}\n${account}`)
    this.options.grants.write(
      this.options.grants
        .read()
        .filter((grant) => !(grant.runtimeId === runtimeId && grant.account === account))
    )
  }
}
