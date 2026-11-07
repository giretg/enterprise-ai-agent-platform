/**
 * Tenant ElevenLabs API-kulcs: ugyanaz a connector-titoktár, mint a többi céges kulcsnál.
 * Nincs platform-env tartalék, a hangot csak a cég saját fiókja fizetheti.
 */
import {
  buildConnectorSecretRef,
  ConnectorApiKeyMissingError,
  loadConnectorApiKeyByRef,
  saveConnectorApiKey,
} from '@/domain/connector/connector-secret-store'

function elevenLabsSecretId(tenantId: string): string {
  return `elevenlabs-${tenantId}`
}

export function parseElevenLabsApiKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('invalid_elevenlabs_key')
  const key = raw.trim()
  // Más szolgáltató sk- kulcsa kötőjellel folytatódik, az ElevenLabsé aláhúzással.
  if (key.length > 200 || !/^[A-Za-z0-9_]{20,}$/.test(key)) throw new Error('invalid_elevenlabs_key')
  return key
}

export async function loadElevenLabsTenantKey(tenantId: string): Promise<string | null> {
  try {
    const key = await loadConnectorApiKeyByRef(buildConnectorSecretRef(elevenLabsSecretId(tenantId)))
    return key.trim() || null
  } catch (e) {
    if (e instanceof ConnectorApiKeyMissingError) return null
    throw e
  }
}

export function saveElevenLabsTenantKey(tenantId: string, apiKey: string): Promise<void> {
  return saveConnectorApiKey(elevenLabsSecretId(tenantId), parseElevenLabsApiKey(apiKey))
}
