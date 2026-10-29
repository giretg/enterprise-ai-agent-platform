import type { Prisma } from '@prisma/client'
import { settingsRecord } from '@/lib/tenant-settings'

/**
 * Mini app szervezeti beállítások (#967 D6, §5.2) a `Tenant.settings.miniApp` alatt:
 * a gyors link élettartama (alap 7 nap, plafon 30 nap) és a HTML méret-plafon
 * (alap 1 MB, csak csökkenthető). Kliens-oldalon is importálható.
 */
export const MINI_APP_SETTINGS_KEY = 'miniApp'

export const MINI_APP_LINK_TTL_OPTIONS = [
  { value: '1h', ms: 60 * 60 * 1000, label: '1 óra' },
  { value: '1d', ms: 24 * 60 * 60 * 1000, label: '1 nap' },
  { value: '7d', ms: 7 * 24 * 60 * 60 * 1000, label: '7 nap' },
  { value: '30d', ms: 30 * 24 * 60 * 60 * 1000, label: '30 nap' },
] as const

export type MiniAppLinkTtl = (typeof MINI_APP_LINK_TTL_OPTIONS)[number]['value']

export const DEFAULT_MINI_APP_LINK_TTL: MiniAppLinkTtl = '7d'
export const MINI_APP_MAX_BYTES_CEILING = 1024 * 1024
export const MINI_APP_MAX_BYTES_OPTIONS = [
  { value: 256 * 1024, label: '256 KB' },
  { value: 512 * 1024, label: '512 KB' },
  { value: MINI_APP_MAX_BYTES_CEILING, label: '1 MB' },
] as const

export type MiniAppTenantSettings = { linkTtl: MiniAppLinkTtl; maxBytes: number }

export function isMiniAppLinkTtl(value: unknown): value is MiniAppLinkTtl {
  return MINI_APP_LINK_TTL_OPTIONS.some((option) => option.value === value)
}

export function readMiniAppSettings(settings: unknown): MiniAppTenantSettings {
  const raw = settingsRecord(settingsRecord(settings)[MINI_APP_SETTINGS_KEY])
  const maxBytes =
    typeof raw.maxBytes === 'number' && Number.isInteger(raw.maxBytes) && raw.maxBytes > 0
      ? Math.min(raw.maxBytes, MINI_APP_MAX_BYTES_CEILING)
      : MINI_APP_MAX_BYTES_CEILING
  return {
    linkTtl: isMiniAppLinkTtl(raw.linkTtl) ? raw.linkTtl : DEFAULT_MINI_APP_LINK_TTL,
    maxBytes,
  }
}

export function withMiniAppSettings(settings: unknown, next: MiniAppTenantSettings): Prisma.InputJsonValue {
  return {
    ...settingsRecord(settings),
    [MINI_APP_SETTINGS_KEY]: { linkTtl: next.linkTtl, maxBytes: Math.min(next.maxBytes, MINI_APP_MAX_BYTES_CEILING) },
  }
}

export function miniAppLinkTtlMs(ttl: MiniAppLinkTtl): number {
  return MINI_APP_LINK_TTL_OPTIONS.find((option) => option.value === ttl)!.ms
}

export function miniAppLinkTtlLabel(ttl: MiniAppLinkTtl): string {
  return MINI_APP_LINK_TTL_OPTIONS.find((option) => option.value === ttl)!.label
}
