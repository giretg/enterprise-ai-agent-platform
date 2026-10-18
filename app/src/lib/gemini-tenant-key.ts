/**
 * Tenant Gemini-kulcs: ugyanaz a connector-titoktár, mint az OpenRouter szervezeti kulcs.
 * A nyers kulcs soha nem kerül DB-be; a Secret Manager id: `connector-key-gemini-<tenantId>`.
 */
import {
  buildConnectorSecretRef,
  ConnectorApiKeyMissingError,
  loadConnectorApiKeyByRef,
  saveConnectorApiKey,
} from '@/domain/connector/connector-secret-store'

export const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'

export function geminiSecretId(tenantId: string): string {
  return `gemini-${tenantId}`
}

/** Régi Google Cloud / AI Studio standard kulcs. */
const STANDARD_GEMINI_API_KEY = /^AIza[0-9A-Za-z_-]{20,}$/
/**
 * Google AI Studio auth-kulcs. 2026-05-28-tól az új kulcsok így jönnek ki.
 * @see https://ai.google.dev/gemini-api/docs/api-key
 */
const AUTH_GEMINI_API_KEY = /^AQ\.[A-Za-z0-9_-]{20,}$/

export function parseGeminiApiKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('invalid_gemini_key')
  const key = raw.trim()
  if (
    key.length > 500 ||
    !(STANDARD_GEMINI_API_KEY.test(key) || AUTH_GEMINI_API_KEY.test(key))
  ) {
    throw new Error('invalid_gemini_key')
  }
  return key
}

export async function loadGeminiTenantKey(tenantId: string): Promise<string | null> {
  try {
    const key = await loadConnectorApiKeyByRef(buildConnectorSecretRef(geminiSecretId(tenantId)))
    return key.trim() || null
  } catch (e) {
    if (e instanceof ConnectorApiKeyMissingError) return null
    throw e
  }
}

export function saveGeminiTenantKey(tenantId: string, apiKey: string): Promise<void> {
  return saveConnectorApiKey(geminiSecretId(tenantId), parseGeminiApiKey(apiKey))
}

/** Tenant-titok nyer; ha nincs, a platform `GEMINI_API_KEY` vagy `GOOGLE_API_KEY` env. */
export async function resolveGeminiApiKey(
  tenantId: string,
  loadTenantKey: (id: string) => Promise<string | null>,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const tenantKey = (await loadTenantKey(tenantId))?.trim()
  if (tenantKey) return tenantKey
  return env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || null
}
