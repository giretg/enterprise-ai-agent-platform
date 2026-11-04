/**
 * Tenant OpenAI API-kulcs: ugyanaz a connector-titoktár, mint az OpenRouter és a Gemini kulcsnál.
 * A nyers kulcs soha nem kerül DB-be; a Secret Manager id: `connector-key-openai-<tenantId>`.
 *
 * Szándékosan nincs platform-env tartalék: az OpenAI-t csak a cég saját kulcsa fizetheti, egy
 * véletlenül beállított `OPENAI_API_KEY` ne a platform számlájára engedje a tenant forgalmát.
 */
import {
  buildConnectorSecretRef,
  ConnectorApiKeyMissingError,
  loadConnectorApiKeyByRef,
  saveConnectorApiKey,
} from '@/domain/connector/connector-secret-store'

export const OPENAI_BASE_URL = 'https://api.openai.com/v1'

export function openAiSecretId(tenantId: string): string {
  return `openai-${tenantId}`
}

/**
 * Projekt- (`sk-proj-`), service account- (`sk-svcacct-`) és régi (`sk-`) kulcs. Elutasítjuk, ami
 * biztosan nem jó ide: az OpenRouter (`sk-or-`) és az Anthropic (`sk-ant-`) kulcsot, valamint az
 * OpenAI admin-kulcsot (`sk-admin-`), amivel nem lehet modellt hívni.
 */
export function parseOpenAiApiKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('invalid_openai_key')
  const key = raw.trim()
  if (key.length > 500 || !/^sk-[A-Za-z0-9_-]{20,}$/.test(key) || /^sk-(or|ant|admin)-/.test(key)) {
    throw new Error('invalid_openai_key')
  }
  return key
}

export async function loadOpenAiTenantKey(tenantId: string): Promise<string | null> {
  try {
    const key = await loadConnectorApiKeyByRef(buildConnectorSecretRef(openAiSecretId(tenantId)))
    return key.trim() || null
  } catch (e) {
    if (e instanceof ConnectorApiKeyMissingError) return null
    throw e
  }
}

export function saveOpenAiTenantKey(tenantId: string, apiKey: string): Promise<void> {
  return saveConnectorApiKey(openAiSecretId(tenantId), parseOpenAiApiKey(apiKey))
}
