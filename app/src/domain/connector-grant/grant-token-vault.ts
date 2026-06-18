/**
 * Per-user connector grant token vault (F2-B).
 * Refresh + access token titkosítva Secret Managerben / dev fájlban — nyers token sosem DB-ben.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getCloudRunAccessToken } from '@/domain/dispatcher/cloud-run-auth'

export type ConnectorGrantTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: string | null
  accountEmail?: string
  scopes?: string[]
  lastRefresh?: string
}

type TokenFileShape = {
  access_token: string
  refresh_token: string
  expires_at?: string | null
  account_email?: string
  scopes?: string[]
  last_refresh?: string
}

function toFileShape(t: ConnectorGrantTokens): TokenFileShape {
  return {
    access_token: t.accessToken,
    refresh_token: t.refreshToken,
    expires_at: t.expiresAt,
    account_email: t.accountEmail,
    scopes: t.scopes,
    last_refresh: t.lastRefresh ?? new Date().toISOString(),
  }
}

function fromFileShape(raw: string): ConnectorGrantTokens {
  const parsed = JSON.parse(raw) as TokenFileShape
  if (!parsed.access_token || !parsed.refresh_token) {
    throw new Error('Grant token payload missing access_token/refresh_token')
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: parsed.expires_at ?? null,
    accountEmail: parsed.account_email,
    scopes: parsed.scopes,
    lastRefresh: parsed.last_refresh,
  }
}

export interface ConnectorGrantTokenStore {
  readonly label: string
  load(): Promise<ConnectorGrantTokens>
  save(tokens: ConnectorGrantTokens): Promise<void>
  delete(): Promise<void>
}

export function buildGrantTokenRef(params: {
  tenantId: string | null
  userId: string
  connectorId: string
}): string {
  const tenant = params.tenantId ?? 'default'
  return `tenant/${tenant}/user/${params.userId}/connector/${params.connectorId}`
}

/** Dev / acceptance: lokális fájl a token_ref kulcson. */
export class FileGrantTokenStore implements ConnectorGrantTokenStore {
  readonly label: string
  constructor(private filePath: string) {
    this.label = `file:${filePath}`
  }

  async load(): Promise<ConnectorGrantTokens> {
    const raw = await readFile(this.filePath, 'utf8')
    return fromFileShape(raw)
  }

  async save(tokens: ConnectorGrantTokens): Promise<void> {
    const dir = this.filePath.slice(0, this.filePath.lastIndexOf('/'))
    await mkdir(dir, { recursive: true })
    await writeFile(this.filePath, JSON.stringify(toFileShape(tokens), null, 2), { mode: 0o600 })
  }

  async delete(): Promise<void> {
    const { unlink } = await import('node:fs/promises')
    await unlink(this.filePath).catch(() => {})
  }
}

export class SecretManagerGrantTokenStore implements ConnectorGrantTokenStore {
  readonly label: string
  constructor(private secretResource: string) {
    this.label = `secret-manager:${secretResource}`
  }

  private async accessToken(): Promise<string> {
    return getCloudRunAccessToken(process.env.SECRET_MANAGER_ACCESS_TOKEN)
  }

  private parseSecretResource(): { parent: string; secretId: string } {
    const match = this.secretResource.match(/^(.+\/secrets)\/([^/]+)$/)
    if (!match) {
      throw new Error(
        'Secret Manager grant resource must look like projects/<project>/secrets/<secret-id>',
      )
    }
    return { parent: match[1], secretId: match[2] }
  }

  private async createSecretIfMissing(token: string): Promise<void> {
    const { parent, secretId } = this.parseSecretResource()
    const res = await fetch(
      `https://secretmanager.googleapis.com/v1/${parent}?secretId=${encodeURIComponent(secretId)}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ replication: { automatic: {} } }),
      },
    )
    if (res.ok || res.status === 409) return
    throw new Error(`Secret Manager create failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
  }

  private async addVersion(token: string, payload: string): Promise<Response> {
    return fetch(`https://secretmanager.googleapis.com/v1/${this.secretResource}:addVersion`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { data: payload } }),
    })
  }

  async load(): Promise<ConnectorGrantTokens> {
    const token = await this.accessToken()
    const res = await fetch(
      `https://secretmanager.googleapis.com/v1/${this.secretResource}/versions/latest:access`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    if (!res.ok) {
      throw new Error(`Secret Manager access failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
    }
    const data = (await res.json()) as { payload?: { data?: string } }
    if (!data.payload?.data) throw new Error('Secret Manager version payload empty')
    return fromFileShape(Buffer.from(data.payload.data, 'base64').toString('utf8'))
  }

  async save(tokens: ConnectorGrantTokens): Promise<void> {
    const token = await this.accessToken()
    const payload = Buffer.from(JSON.stringify(toFileShape(tokens)), 'utf8').toString('base64')
    let res = await this.addVersion(token, payload)
    if (res.status === 404) {
      await this.createSecretIfMissing(token)
      res = await this.addVersion(token, payload)
    }
    if (!res.ok) {
      throw new Error(`Secret Manager addVersion failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
    }
  }

  async delete(): Promise<void> {
    const token = await this.accessToken()
    const versionsRes = await fetch(
      `https://secretmanager.googleapis.com/v1/${this.secretResource}/versions`,
      { headers: { authorization: `Bearer ${token}` } },
    ).catch(() => null)
    if (!versionsRes || versionsRes.status === 404) return
    if (!versionsRes.ok) {
      throw new Error(
        `Secret Manager list versions failed: ${versionsRes.status} ${(await versionsRes.text()).slice(0, 200)}`,
      )
    }

    const data = (await versionsRes.json()) as {
      versions?: Array<{ name?: string; state?: string }>
    }
    const versions = data.versions ?? []
    await Promise.all(
      versions
        .filter((version) => version.name && version.state !== 'DESTROYED')
        .map((version) =>
          fetch(`https://secretmanager.googleapis.com/v1/${version.name}:destroy`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({}),
          }).catch(() => null),
        ),
    )
  }
}

export function createGrantTokenStore(tokenRef: string): ConnectorGrantTokenStore {
  const secretPrefix = process.env.CONNECTOR_GRANT_SECRET_PREFIX?.trim()
  if (secretPrefix) {
    const secretName = tokenRef.replace(/\//g, '-')
    return new SecretManagerGrantTokenStore(`${secretPrefix}/${secretName}`)
  }
  const root = process.env.CONNECTOR_GRANT_TOKEN_DIR?.trim() || join(process.cwd(), '.connector-grants')
  const safePath = tokenRef.replace(/[^a-zA-Z0-9/_-]/g, '_')
  return new FileGrantTokenStore(join(root, `${safePath}.json`))
}

export function isAccessTokenExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return true
  const ms = Date.parse(expiresAt)
  if (Number.isNaN(ms)) return true
  return Date.now() >= ms - 60_000
}
