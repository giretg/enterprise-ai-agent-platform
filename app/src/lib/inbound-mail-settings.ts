import type { Prisma } from '@prisma/client'
import { settingsRecord } from '@/lib/tenant-settings'

/**
 * #1032 bejövő levelek cégszintű beállítása a `Tenant.settings.inboundMail` alatt.
 * `pollMinutes`: az azonnali értesítés nélküli postafiókokat ilyen gyakran nézzük meg — de csak
 * amíg a platformot használja valaki (tétlen platformon nincs fölösleges adatbázis-ébresztés).
 * Kliens-oldalon is importálható.
 */
export const INBOUND_MAIL_SETTINGS_KEY = 'inboundMail'
export const INBOUND_POLL_OPTIONS = [5, 15, 30, 60] as const
export type InboundPollMinutes = (typeof INBOUND_POLL_OPTIONS)[number]
export const DEFAULT_INBOUND_POLL_MINUTES: InboundPollMinutes = 15

export type InboundMailTenantSettings = { pollMinutes: InboundPollMinutes }

export function isInboundPollMinutes(value: unknown): value is InboundPollMinutes {
  return INBOUND_POLL_OPTIONS.includes(value as InboundPollMinutes)
}

export function readInboundMailSettings(settings: unknown): InboundMailTenantSettings {
  const raw = settingsRecord(settingsRecord(settings)[INBOUND_MAIL_SETTINGS_KEY])
  return { pollMinutes: isInboundPollMinutes(raw.pollMinutes) ? raw.pollMinutes : DEFAULT_INBOUND_POLL_MINUTES }
}

export function withInboundMailSettings(settings: unknown, next: InboundMailTenantSettings): Prisma.InputJsonValue {
  return { ...settingsRecord(settings), [INBOUND_MAIL_SETTINGS_KEY]: next }
}

export function inboundPollLabel(minutes: number): string {
  return minutes >= 60 ? `${minutes / 60} óránként` : `${minutes} percenként`
}
