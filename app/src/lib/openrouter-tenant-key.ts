/**
 * Tenant OpenRouter-kulcs: ugyanaz a connector-titoktár, mint az AgentMail szervezeti kulcs.
 * A nyers kulcs soha nem kerül DB-be; a Secret Manager id: `connector-key-openrouter-<tenantId>`.
 */
import {
  buildConnectorSecretRef,
  ConnectorApiKeyMissingError,
  loadConnectorApiKeyByRef,
  saveConnectorApiKey,
} from '@/domain/connector/connector-secret-store'

export function openRouterSecretId(tenantId: string): string {
  return `openrouter-${tenantId}`
}

export function parseOpenRouterApiKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('invalid_openrouter_key')
  const key = raw.trim()
  if (key.length > 500 || !/^sk-or-[A-Za-z0-9_-]{20,}$/.test(key)) {
    throw new Error('invalid_openrouter_key')
  }
  return key
}

export async function loadOpenRouterTenantKey(tenantId: string): Promise<string | null> {
  try {
    const key = await loadConnectorApiKeyByRef(buildConnectorSecretRef(openRouterSecretId(tenantId)))
    return key.trim() || null
  } catch (e) {
    if (e instanceof ConnectorApiKeyMissingError) return null
    throw e
  }
}

export function saveOpenRouterTenantKey(tenantId: string, apiKey: string): Promise<void> {
  return saveConnectorApiKey(openRouterSecretId(tenantId), parseOpenRouterApiKey(apiKey))
}

/** Tenant-titok nyer; ha nincs, a platform `OPENROUTER_API_KEY` env (visszafelé kompat). */
export async function resolveOpenRouterApiKey(
  tenantId: string,
  loadTenantKey: (id: string) => Promise<string | null>,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const tenantKey = (await loadTenantKey(tenantId))?.trim()
  if (tenantKey) return tenantKey
  return env.OPENROUTER_API_KEY?.trim() || null
}
