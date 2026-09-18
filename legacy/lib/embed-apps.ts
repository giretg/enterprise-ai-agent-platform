import type { Prisma } from '@prisma/client'
import { envelopeEmbeddedContextForModel } from '@/domain/tool-broker/tool-result-envelope'
import { settingsRecord } from '@/lib/tenant-settings'

/**
 * Beágyazott agent-chat — „Beágyazó alkalmazások" allowlist (feature-spec #481, D7).
 *
 * ÜZLETI JELENTÉS: itt sorolja fel a tenant-admin, mely külső rendszerek (pl. a
 * CRM) nyithatnak a platform chat-ablakából beszélgetést. Egy bejegyzés = egy
 * gomb egy külső appban. Üres lista = a beágyazott chat a tenantnak zárva —
 * külön kapcsoló nincs, a lista maga a kapu.
 *
 * TÁROLÁS: `tenants.settings.embedApps`, tábla nélkül (a nav-visibility mintája).
 */

export const EMBED_APPS_SETTING = 'embedApps'

export type EmbedApp = { slug: string; name: string; origin: string }

const MAX_APPS = 20
const SLUG_MAX_LENGTH = 40
/** D4: az `eai:context` üzenet (label + data) felső mérete — bájtban, UTF-8 szerint. */
export const EMBED_CONTEXT_MAX_BYTES = 8 * 1024

/** A beágyazó app `postMessage`-ből kapott kontextusa — nyersen, burkolat nélkül. */
export type EmbeddedContext = { appSlug: string; label: string; data: unknown }

/** Emberi névből URL-biztos slug — ékezet nélkül, kötőjelezve. */
export function slugifyAppName(name: string): string {
  return name
    .trim()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
}

/** Ütköző slug esetén `-2`, `-3`, … utótaggal old fel. */
export function uniqueEmbedAppSlug(existing: readonly EmbedApp[], base: string): string {
  const taken = new Set(existing.map((a) => a.slug))
  const root = base || 'app'
  if (!taken.has(root)) return root
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${root}-${n}`.slice(0, SLUG_MAX_LENGTH)
    if (!taken.has(candidate)) return candidate
  }
  return `${root}-${Date.now()}`.slice(0, SLUG_MAX_LENGTH)
}

/** Csak https/http origin, path/query nélkül — az összehasonlítás pontos egyezésre megy (D4). */
export function isValidEmbedOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
  } catch {
    return false
  }
}

function sanitizeEntry(raw: unknown): EmbedApp | null {
  if (!raw || typeof raw !== 'object') return null
  const slug = 'slug' in raw && typeof raw.slug === 'string' ? raw.slug.trim() : ''
  const name = 'name' in raw && typeof raw.name === 'string' ? raw.name.trim() : ''
  const origin = 'origin' in raw && typeof raw.origin === 'string' ? raw.origin.trim() : ''
  if (!slug || !name || !isValidEmbedOrigin(origin)) return null
  return { slug, name, origin }
}

export function readEmbedApps(settings: unknown): EmbedApp[] {
  const raw = settingsRecord(settings)[EMBED_APPS_SETTING]
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const apps: EmbedApp[] = []
  for (const entry of raw) {
    const app = sanitizeEntry(entry)
    if (!app || seen.has(app.slug)) continue
    seen.add(app.slug)
    apps.push(app)
  }
  return apps.slice(0, MAX_APPS)
}

export function withEmbedApps(settings: unknown, apps: readonly EmbedApp[]): Prisma.InputJsonValue {
  return {
    ...settingsRecord(settings),
    [EMBED_APPS_SETTING]: apps.slice(0, MAX_APPS),
  }
}

export function findEmbedApp(apps: readonly EmbedApp[], slug: string): EmbedApp | undefined {
  return apps.find((a) => a.slug === slug)
}

/** Kliens és szerver UGYANEZZEL mér, hogy ami a böngészőn átment, a route-on ne bukjon. */
export function embeddedContextByteSize(ctx: Pick<EmbeddedContext, 'label' | 'data'>): number {
  return new TextEncoder().encode(`${ctx.label}: ${JSON.stringify(ctx.data)}`).length
}

/**
 * Szerveroldali burkolás (D4, #97): az allowlist-ellenőrzés és az untrusted burkolat
 * itt készül, NEM a böngészőben — a kliens csak nyers `{ appSlug, label, data }`-t
 * küldhet, így a `source` címke nem hamisítható és burkolatlan prefix nem juthat
 * a promptba.
 */
export function embeddedContextToModelPrefix(
  apps: readonly EmbedApp[],
  ctx: EmbeddedContext,
): { ok: true; prefix: string } | { ok: false; reason: 'app_not_allowed' | 'too_large' } {
  if (!findEmbedApp(apps, ctx.appSlug)) return { ok: false, reason: 'app_not_allowed' }
  if (embeddedContextByteSize(ctx) > EMBED_CONTEXT_MAX_BYTES) return { ok: false, reason: 'too_large' }
  return {
    ok: true,
    prefix: envelopeEmbeddedContextForModel(
      `embedded_app:${ctx.appSlug}`,
      `${ctx.label}: ${JSON.stringify(ctx.data)}`,
    ),
  }
}
