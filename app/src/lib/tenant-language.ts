import type { Prisma } from '@prisma/client'
import { settingsRecord } from '@/lib/tenant-settings'

/** Tenant kimeneti nyelve — skill/playbook promptok és emberi szövegek. */
export type TenantLanguage = 'hu' | 'en'

export const TENANT_LANGUAGE_SETTING = 'language'

/** Alapértelmezés: magyar (a control-plane UI és a chat is hu). */
export const DEFAULT_TENANT_LANGUAGE: TenantLanguage = 'hu'

export const TENANT_LANGUAGE_OPTIONS: ReadonlyArray<{
  value: TenantLanguage
  label: string
  nativeLabel: string
}> = [
  { value: 'hu', label: 'Magyar', nativeLabel: 'Hungarian' },
  { value: 'en', label: 'English', nativeLabel: 'English' },
]

export function isTenantLanguage(value: unknown): value is TenantLanguage {
  return value === 'hu' || value === 'en'
}

export function readTenantLanguage(settings: unknown): TenantLanguage {
  const raw = settingsRecord(settings)[TENANT_LANGUAGE_SETTING]
  return isTenantLanguage(raw) ? raw : DEFAULT_TENANT_LANGUAGE
}

export function withTenantLanguage(
  settings: unknown,
  language: TenantLanguage,
): Prisma.InputJsonValue {
  return { ...settingsRecord(settings), [TENANT_LANGUAGE_SETTING]: language }
}

/**
 * System-prompt utasítás propose-not-apply agenteknek: emberi szövegek a tenant
 * nyelvén, JSON kulcsok / séma mezőnevek angolul maradnak.
 */
export function outputLanguageInstruction(language: TenantLanguage): string {
  const name = TENANT_LANGUAGE_OPTIONS.find((o) => o.value === language)?.nativeLabel ?? 'Hungarian'
  return (
    `OUTPUT LANGUAGE: Write all human-readable string values (name, description, ` +
    `instructions, instructionTemplate, role/step prose, triggerKeywords, etc.) in ${name}. ` +
    `Keep JSON keys and schema field names in English. Do not mix languages.`
  )
}
