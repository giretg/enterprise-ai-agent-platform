import type { Prisma } from '@prisma/client'

/** `Tenant.settings` Json → kulcs-térkép; bármi más (null, tömb, primitív) üres. */
export function settingsRecord(value: unknown): Record<string, Prisma.JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : {}
}
