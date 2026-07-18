import { extractJsonObject } from '@/domain/provisioning/provisioning-assistant'

/**
 * Laza mód: best-effort JSON-objektum kinyerés validáció és javítás nélkül.
 * Szándékosan toleráns hívóknak (pl. chat-trigger slot filling).
 */
export function extractLoose(text: string): Record<string, unknown> | null {
  const parsed = extractJsonObject(text)
  if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return null
}
