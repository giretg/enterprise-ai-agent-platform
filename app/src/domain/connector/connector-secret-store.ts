/**
 * Service-módú connector API-kulcs tároló (http_api).
 *
 * A UI-ból bevitt API-kulcs SOHA nem kerül a DB-be: titkosítva/elkülönítve
 * tárolódik (Secret Manager prod, lokális fájl dev), a `connectors.secret_alias`
 * csak egy `secret-ref:<connectorId>` referenciát tart. A feloldást a Tool Broker
 * végzi szerveroldalon (lásd resolveConnectorApiKey).
 *
 * Ugyanaz a build-vs-adopt cserepont, mint a grant-token-vaultnál: a tároló a
 * `secretAlias` mögött van, később kiváltható.
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getCloudRunAccessToken } from '@/domain/net/cloud-run-auth'

const SECRET_REF_PREFIX = 'secret-ref:'

/**
 * A connector API-kulcsa nincs (még) beállítva a titok-tárolóban: Secret Manager 404
 * (a `connector-key-<id>` secret/verzió nem létezik) vagy dev-fájl ENOENT, ill. üres verzió.
 * TIPIZÁLT hiba, hogy a hívó (pl. web_search handler) FELHASZNÁLÓBARÁT, cselekvésre okító
 * üzenetté fordíthassa a nyers „Secret Manager access failed: 404" helyett.
 */
export class ConnectorApiKeyMissingError extends Error {
  constructor(
    public readonly secretId: string,
    public readonly reason: 'not_found' | 'empty',
  ) {
    super(`Connector API key not configured (${secretId}, ${reason})`)
    this.name = 'ConnectorApiKeyMissingError'
  }
}

export function buildConnectorSecretRef(connectorId: string): string {
  return `${SECRET_REF_PREFIX}${connectorId}`
}

export function isConnectorSecretRef(alias: string): boolean {
  return alias.startsWith(SECRET_REF_PREFIX)
}

function secretIdFromRef(ref: string): string {
  return ref.slice(SECRET_REF_PREFIX.length).trim()
}

function smResource(secretId: string): string {
  const prefix = process.env.CONNECTOR_SECRET_PREFIX!.replace(/\/+$/, '')
  return `${prefix}/connector-key-${secretId}`
}

function devFilePath(secretId: string): string {
  const root = process.env.CONNECTOR_SECRET_DIR?.trim() || join(process.cwd(), '.connector-secrets')
  const safe = secretId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(root, `${safe}.key`)
}

async function smAccessToken(): Promise<string> {
  return getCloudRunAccessToken(process.env.SECRET_MANAGER_ACCESS_TOKEN)
}

async function smCreateIfMissing(resource: string, token: string): Promise<void> {
  const match = resource.match(/^(.+\/secrets)\/([^/]+)$/)
  if (!match) throw new Error('CONNECTOR_SECRET_PREFIX must look like projects/<p>/secrets')
  const res = await fetch(
    `https://secretmanager.googleapis.com/v1/${match[1]}?secretId=${encodeURIComponent(match[2])}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ replication: { automatic: {} } }),
    },
  )
  if (res.ok || res.status === 409) return
  throw new Error(`Secret Manager create failed: ${res.status}`)
}

export async function saveConnectorApiKey(connectorId: string, apiKey: string): Promise<void> {
  if (!apiKey.trim()) throw new Error('API key must not be empty')

  if (process.env.CONNECTOR_SECRET_PREFIX?.trim()) {
    const resource = smResource(connectorId)
    const token = await smAccessToken()
    const payload = Buffer.from(apiKey, 'utf8').toString('base64')
    const add = () =>
      fetch(`https://secretmanager.googleapis.com/v1/${resource}:addVersion`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ payload: { data: payload } }),
      })
    let res = await add()
    if (res.status === 404) {
      await smCreateIfMissing(resource, token)
      res = await add()
    }
    if (!res.ok) throw new Error(`Secret Manager addVersion failed: ${res.status}`)
    return
  }

  const filePath = devFilePath(connectorId)
  await mkdir(filePath.slice(0, filePath.lastIndexOf('/')), { recursive: true })
  await writeFile(filePath, apiKey, { mode: 0o600 })
}

export async function loadConnectorApiKeyByRef(ref: string): Promise<string> {
  const secretId = secretIdFromRef(ref)

  if (process.env.CONNECTOR_SECRET_PREFIX?.trim()) {
    const token = await smAccessToken()
    const res = await fetch(
      `https://secretmanager.googleapis.com/v1/${smResource(secretId)}/versions/latest:access`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    // 404 = a titok (vagy a `latest` verzió) nincs beállítva → tipizált „hiányzó kulcs" hiba,
    // hogy a hívó felhasználóbarát üzenetet adhasson. Más státusz (401/403/5xx) valódi
    // hozzáférési/hálózati hiba marad.
    if (res.status === 404) throw new ConnectorApiKeyMissingError(secretId, 'not_found')
    if (!res.ok) throw new Error(`Secret Manager access failed: ${res.status}`)
    const data = (await res.json()) as { payload?: { data?: string } }
    if (!data.payload?.data) throw new ConnectorApiKeyMissingError(secretId, 'empty')
    return Buffer.from(data.payload.data, 'base64').toString('utf8').trim()
  }

  try {
    const raw = await readFile(devFilePath(secretId), 'utf8')
    return raw.trim()
  } catch (e) {
    // Dev: a lokális kulcs-fájl nem létezik → ugyanaz a „hiányzó kulcs" eset, mint prod 404.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new ConnectorApiKeyMissingError(secretId, 'not_found')
    }
    throw e
  }
}

export async function deleteConnectorApiKey(connectorId: string): Promise<void> {
  if (process.env.CONNECTOR_SECRET_PREFIX?.trim()) {
    // Secret Manager: a verziók destroy-olása opcionális; itt csak best-effort.
    const token = await smAccessToken().catch(() => null)
    if (!token) return
    await fetch(`https://secretmanager.googleapis.com/v1/${smResource(connectorId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => null)
    return
  }
  await unlink(devFilePath(connectorId)).catch(() => {})
}
