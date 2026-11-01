import type { Prisma } from '@prisma/client'
import { settingsRecord } from '@/lib/tenant-settings'

/**
 * Beépített platform-chat (#1004 D2/D14/D15) a `Tenant.settings.platformChat` alatt.
 * - `enabled`: admin kapcsoló, csak beállított OpenRouter-kulccsal kapcsolható be;
 * - `dailyBudgetUsd`: kötelező napi modell-keret (bekapcsoláskor meg kell adni);
 * - `adminInsight`: csak superadmin állíthatja — a tenant admin láthatja-e a userek beszélgetéseit.
 * Kliens-oldalon is importálható.
 */
export const PLATFORM_CHAT_SETTINGS_KEY = 'platformChat'
export const PLATFORM_CHAT_SUGGESTED_BUDGET_USD = 10
export const PLATFORM_CHAT_MAX_BUDGET_USD = 10_000

export type PlatformChatTenantSettings = {
  enabled: boolean
  /** null = még nincs megadva (ilyenkor a chat nem kapcsolható be). */
  dailyBudgetUsd: number | null
  adminInsight: boolean
}

export function isValidPlatformChatBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= PLATFORM_CHAT_MAX_BUDGET_USD
}

export function readPlatformChatSettings(settings: unknown): PlatformChatTenantSettings {
  const raw = settingsRecord(settingsRecord(settings)[PLATFORM_CHAT_SETTINGS_KEY])
  const dailyBudgetUsd = isValidPlatformChatBudget(raw.dailyBudgetUsd) ? raw.dailyBudgetUsd : null
  return {
    // Keret nélkül nincs bekapcsolt állapot, akkor sem, ha a JSON-ban true áll.
    enabled: raw.enabled === true && dailyBudgetUsd !== null,
    dailyBudgetUsd,
    adminInsight: raw.adminInsight === true,
  }
}

export function withPlatformChatSettings(
  settings: unknown,
  next: Partial<PlatformChatTenantSettings>,
): Prisma.InputJsonValue {
  const current = readPlatformChatSettings(settings)
  const merged = { ...current, ...next }
  return { ...settingsRecord(settings), [PLATFORM_CHAT_SETTINGS_KEY]: merged }
}

/** A keret napja: Europe/Budapest naptári nap (éjfélkor nullázódik), `YYYY-MM-DD`. */
export function platformChatBudgetDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Budapest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}
