/**
 * S2 — OAuth token tároló a beágyazott (in-process) ChatGPT mediátorhoz.
 *
 * A „Sign in with ChatGPT" tokeneket szerveroldalon tartjuk. Két backend:
 *  - FileTokenStore: lokális ~/.codex/auth.json (dev / sidecar).
 *  - SecretManagerTokenStore: GCP Secret Manager (éles App Hosting) — a
 *    metadata-token + REST mintát követi (lásd cloud-run-auth.ts), nincs külön
 *    GCP client lib. Lejáratkor a frissített refresh_token ÚJ secret verzióként
 *    visszamentődik (write-back), így a token önállóan fennmarad újraindítás után.
 *
 * A secret payload formátuma megegyezik a Codex auth.json-jával:
 *   { "tokens": { "access_token", "refresh_token", "account_id", "id_token"? }, "last_refresh"? }
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getCloudRunAccessToken } from '../dispatcher/cloud-run-auth'
import {
  isAccessTokenExpired,
  refreshAccessToken,
  type ChatGptOAuthTokens,
} from './chatgpt-oauth-bridge'

export type CodexAuthTokens = {
  accessToken: string
  refreshToken: string
  accountId: string
  idToken?: string
  lastRefresh?: string
}

export interface OAuthTokenStore {
  readonly label: string
  load(): Promise<CodexAuthTokens>
  save(tokens: CodexAuthTokens): Promise<void>
}

type AuthFileShape = {
  tokens: { access_token: string; refresh_token: string; account_id: string; id_token?: string }
  last_refresh?: string
}

function toAuthFileShape(t: CodexAuthTokens): AuthFileShape {
  return {
    tokens: {
      access_token: t.accessToken,
      refresh_token: t.refreshToken,
      account_id: t.accountId,
      ...(t.idToken ? { id_token: t.idToken } : {}),
    },
    last_refresh: t.lastRefresh ?? new Date().toISOString(),
  }
}

function fromAuthFileShape(raw: string): CodexAuthTokens {
  const parsed = JSON.parse(raw) as AuthFileShape
  if (!parsed.tokens?.access_token || !parsed.tokens?.refresh_token || !parsed.tokens?.account_id) {
    throw new Error('OAuth token payload missing access_token/refresh_token/account_id')
  }
  return {
    accessToken: parsed.tokens.access_token,
    refreshToken: parsed.tokens.refresh_token,
    accountId: parsed.tokens.account_id,
    idToken: parsed.tokens.id_token,
    lastRefresh: parsed.last_refresh,
  }
}

/** Lokális auth.json (dev / sidecar). */
export class FileTokenStore implements OAuthTokenStore {
  readonly label: string
  constructor(private path: string) {
    this.label = `file:${path}`
  }
  async load(): Promise<CodexAuthTokens> {
    return fromAuthFileShape(readFileSync(this.path, 'utf8'))
  }
  async save(tokens: CodexAuthTokens): Promise<void> {
    writeFileSync(this.path, JSON.stringify(toAuthFileShape(tokens), null, 2), { mode: 0o600 })
  }
}

/**
 * GCP Secret Manager (éles). A secret resource: `projects/<id>/secrets/<name>`.
 * Olvasás: `versions/latest:access`; írás: `:addVersion` (új verzió).
 */
export class SecretManagerTokenStore implements OAuthTokenStore {
  readonly label: string
  constructor(private secretResource: string) {
    this.label = `secret-manager:${secretResource}`
  }

  private async accessToken(): Promise<string> {
    return getCloudRunAccessToken(process.env.SECRET_MANAGER_ACCESS_TOKEN)
  }

  async load(): Promise<CodexAuthTokens> {
    const token = await this.accessToken()
    const res = await fetch(
      `https://secretmanager.googleapis.com/v1/${this.secretResource}/versions/latest:access`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    if (!res.ok) {
      // A Secret Manager választeste külső hibaadat; ne kerüljön auditba vagy
      // felhasználói hibaüzenetbe, még akkor sem, ha egy proxy visszhangozza.
      throw new Error(`Secret Manager access failed: ${res.status}`)
    }
    const data = (await res.json()) as { payload?: { data?: string } }
    if (!data.payload?.data) throw new Error('Secret Manager version payload empty')
    return fromAuthFileShape(Buffer.from(data.payload.data, 'base64').toString('utf8'))
  }

  async save(tokens: CodexAuthTokens): Promise<void> {
    const token = await this.accessToken()
    const payload = Buffer.from(JSON.stringify(toAuthFileShape(tokens)), 'utf8').toString('base64')
    const res = await fetch(
      `https://secretmanager.googleapis.com/v1/${this.secretResource}:addVersion`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ payload: { data: payload } }),
      },
    )
    if (!res.ok) {
      throw new Error(`Secret Manager addVersion failed: ${res.status}`)
    }
  }
}

/**
 * A beágyazott provider token-tárolója env alapján:
 *  - CHATGPT_OAUTH_TOKEN_SECRET beállítva → Secret Manager (éles).
 *  - különben CHATGPT_OAUTH_EMBEDDED=true → lokális fájl (CODEX_AUTH_FILE vagy ~/.codex/auth.json).
 *  - különben null (a provider nem beágyazott módban van).
 */
export function createTokenStoreFromEnv(): OAuthTokenStore | null {
  const secret = process.env.CHATGPT_OAUTH_TOKEN_SECRET?.trim()
  if (secret) return new SecretManagerTokenStore(secret)
  if (process.env.CHATGPT_OAUTH_EMBEDDED === 'true') {
    const path = process.env.CODEX_AUTH_FILE?.trim() || join(homedir(), '.codex', 'auth.json')
    return new FileTokenStore(path)
  }
  return null
}

/**
 * Betölti a tokeneket, lejárat előtt frissít és write-back-el, majd visszaadja a
 * híváshoz használandó (access_token, account_id) párt.
 */
export async function ensureFreshTokens(store: OAuthTokenStore): Promise<ChatGptOAuthTokens> {
  const current = await store.load()
  if (!isAccessTokenExpired(current.accessToken)) {
    return { accessToken: current.accessToken, accountId: current.accountId }
  }
  const refreshed = await refreshAccessToken(current.refreshToken)
  const next: CodexAuthTokens = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    accountId: current.accountId,
    idToken: refreshed.idToken ?? current.idToken,
    lastRefresh: new Date().toISOString(),
  }
  await store.save(next)
  return { accessToken: next.accessToken, accountId: next.accountId }
}
