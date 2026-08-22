/**
 * Forrás privacy-katalógus szinkron (forrás-szerződés §6.1, issue #320).
 *
 * A mezőjelölés kanonikus helye a forrásrendszer: a platform a `GET /privacy/catalog`
 * választ olvassa be a connector-config `fields` / `privacy` / `entity_types` /
 * `unlisted_default` kulcsaiba. Enélkül a jelölés kézi másolással csúszik el a
 * forrástól — és a platform vagy kevesebbet véd, vagy olyan mezőt tokenizál,
 * amit a forrás már nem is jelöl.
 *
 * Fail-closed: érvénytelen katalógus (pl. `tokenize` numerikus mezőn, `reversible:
 * false` típusra) NEM kerül be. Ilyenkor a RÉGI, érvényes jelölés marad érvényben,
 * és a hiba auditba megy — a tokenizálás nem esik szét egy rossz publikálástól.
 *
 * Ez a modul tiszta-ish: nincs DB és nincs audit; a HTTP-kliens injektálható,
 * így a tesztek hálózat nélkül futnak.
 */
import { HttpApiClient, parseHttpApiConfig } from '@/domain/connector/http-api-client'
import {
  parsePrivacyCatalogV2,
  privacyCatalogToConnectorConfigPatch,
  readPrivacyCatalogPath,
  reviewPrivacyCatalogDeclarations,
  type ConnectorFieldPrivacy,
  type PrivacyCatalogV2,
  type PrivacyEntityTypeDeclaration,
} from '@/domain/privacy/connector-privacy'
import {
  ConnectorConfigParseError,
  normalizeConnectorConfig,
} from '@/domain/provisioning/connector-config'

export type PrivacyCatalogFetchFailReason =
  | 'not_http_api'
  | 'unreachable'
  | 'http_error'
  | 'invalid_catalog'

export type PrivacyCatalogSyncFailReason = PrivacyCatalogFetchFailReason | 'invalid_config'

export type PrivacyCatalogFetchResult =
  | { ok: true; catalog: PrivacyCatalogV2 }
  | { ok: false; reason: PrivacyCatalogFetchFailReason; detail: string }

export type PrivacyCatalogSyncOutcome =
  | {
      status: 'applied'
      catalogVersion: number
      /** A perzisztálandó nyers connector-config (a nem modellezett kulcsok megmaradnak). */
      config: Record<string, unknown>
      /** Ember által olvasható változáslista az auditba és az admin visszajelzéshez. */
      changes: string[]
      /** D5 — `pass` jelölésű, titoknak látszó mezőnevek (nem blokkol). */
      warnings: string[]
    }
  | { status: 'no_change'; catalogVersion: number }
  | { status: 'failed'; reason: PrivacyCatalogSyncFailReason; detail: string }

export type PrivacyCatalogFetcher = (input: {
  config: unknown
  apiKey?: string
  resolveApiKey?: (secretAlias: string) => Promise<string>
  actingUserEmail?: string | null
}) => Promise<PrivacyCatalogFetchResult>

/**
 * A katalógus-végpont a platform SAJÁT, szerződéses hívása — nem a modellé.
 * Ezért `restrictToEndpoints` mellett is hívható: az allowlist a modell által
 * indított hívásokat korlátozza, nem a privacy-réteget.
 */
function catalogHttpConfig(config: unknown, path: string) {
  const parsed = parseHttpApiConfig(config)
  if (!parsed.restrictToEndpoints) return parsed
  const known = (parsed.endpoints ?? []).some(
    (endpoint) => endpoint.method === 'GET' && endpoint.path === path,
  )
  if (known) return parsed
  return {
    ...parsed,
    endpoints: [
      ...(parsed.endpoints ?? []),
      { method: 'GET', path, access: 'read' as const, risk: 'read' as const, idempotent: false },
    ],
  }
}

export const fetchConnectorPrivacyCatalog: PrivacyCatalogFetcher = async (input) => {
  const path = readPrivacyCatalogPath(input.config)
  let client: HttpApiClient
  try {
    client = new HttpApiClient(catalogHttpConfig(input.config, path), {
      defaultApiKey: input.apiKey,
      resolveProfileApiKey: (_profile, secretAlias) =>
        input.resolveApiKey
          ? input.resolveApiKey(secretAlias)
          : Promise.reject(new Error('nincs feloldható connector-titok')),
    })
  } catch (error) {
    return { ok: false, reason: 'not_http_api', detail: describe(error) }
  }

  const actingUser = input.actingUserEmail?.trim()
  try {
    const response = await client.request({
      method: 'GET',
      path,
      headers: actingUser ? { 'X-Acting-User': actingUser } : {},
    })
    if (!response.ok) {
      return { ok: false, reason: 'http_error', detail: `HTTP ${response.status}` }
    }
    const catalog = parsePrivacyCatalogV2(response.body)
    if (!catalog) {
      return {
        ok: false,
        reason: 'invalid_catalog',
        detail: 'a válasz nem felel meg a katalógus-sémának (entity_types / fields / tokenize szabályok)',
      }
    }
    return { ok: true, catalog }
  } catch (error) {
    return { ok: false, reason: 'unreachable', detail: describe(error) }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type PrivacySlice = {
  fields?: Record<string, ConnectorFieldPrivacy>
  privacy?: unknown
  entity_types?: Record<string, PrivacyEntityTypeDeclaration>
  unlisted_default?: unknown
  catalog_version?: unknown
}

function privacySlice(config: unknown): PrivacySlice {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  const record = config as Record<string, unknown>
  return {
    fields: record.fields as PrivacySlice['fields'],
    privacy: record.privacy,
    entity_types: record.entity_types as PrivacySlice['entity_types'],
    unlisted_default: record.unlisted_default,
    catalog_version: record.catalog_version,
  }
}

function describeField(field: ConnectorFieldPrivacy | undefined): string {
  if (!field) return '‹nincs›'
  return field.privacy === 'tokenize'
    ? `tokenize/${field.entity_type ?? '?'}${field.source_id ? ` (${field.source_id})` : ''}`
    : field.privacy
}

/** Ember által olvasható változáslista — ez megy az auditba és az admin elé. */
export function describePrivacyCatalogChanges(before: unknown, after: unknown): string[] {
  const from = privacySlice(before)
  const to = privacySlice(after)
  const changes: string[] = []

  const fieldNames = new Set([
    ...Object.keys(from.fields ?? {}),
    ...Object.keys(to.fields ?? {}),
  ])
  for (const name of [...fieldNames].sort()) {
    const previous = from.fields?.[name]
    const next = to.fields?.[name]
    if (JSON.stringify(previous ?? null) === JSON.stringify(next ?? null)) continue
    if (!previous) changes.push(`mező hozzáadva: ${name} → ${describeField(next)}`)
    else if (!next) changes.push(`mező törölve: ${name} (volt: ${describeField(previous)})`)
    else changes.push(`mező módosult: ${name} — ${describeField(previous)} → ${describeField(next)}`)
  }

  const typeNames = new Set([
    ...Object.keys(from.entity_types ?? {}),
    ...Object.keys(to.entity_types ?? {}),
  ])
  for (const name of [...typeNames].sort()) {
    const previous = from.entity_types?.[name]
    const next = to.entity_types?.[name]
    if (JSON.stringify(previous ?? null) === JSON.stringify(next ?? null)) continue
    if (!previous) changes.push(`entitástípus hozzáadva: ${name}`)
    else if (!next) changes.push(`entitástípus törölve: ${name}`)
    else changes.push(`entitástípus módosult: ${name}`)
  }

  if ((from.unlisted_default ?? 'pass') !== (to.unlisted_default ?? 'pass')) {
    changes.push(`jelöletlen mezők: ${from.unlisted_default ?? 'pass'} → ${to.unlisted_default ?? 'pass'}`)
  }
  if (JSON.stringify(from.privacy ?? null) !== JSON.stringify(to.privacy ?? null)) {
    changes.push('capability-deklaráció módosult')
  }
  if ((from.catalog_version ?? null) !== (to.catalog_version ?? null)) {
    changes.push(`katalógusverzió: ${from.catalog_version ?? '‹nincs›'} → ${to.catalog_version ?? '‹nincs›'}`)
  }
  return changes
}

/**
 * Katalógus → connector-config (tiszta). A katalógusban SZEREPLŐ kulcsokat
 * felülírja; a hiányzókat érintetlenül hagyja (a `fields` kötelező, tehát a
 * mezőjelölés mindig a forrásé). A `catalog_version`-t is átvesszük: erről
 * derül ki később, hogy a tárolt jelölés melyik publikációhoz tartozik.
 */
export function applyPrivacyCatalogToConfig(
  rawConfig: unknown,
  catalog: PrivacyCatalogV2,
): PrivacyCatalogSyncOutcome {
  const patch = privacyCatalogToConnectorConfigPatch(catalog)
  const base =
    rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
      ? { ...(rawConfig as Record<string, unknown>) }
      : {}
  const next: Record<string, unknown> = {
    ...base,
    fields: patch.fields,
    catalog_version: patch.catalog_version,
    ...(patch.privacy ? { privacy: { ...(readPrivacyExtras(base)), ...patch.privacy } } : {}),
    ...(patch.entity_types ? { entity_types: patch.entity_types } : {}),
    ...(patch.unlisted_default ? { unlisted_default: patch.unlisted_default } : {}),
  }

  try {
    normalizeConnectorConfig(next)
  } catch (error) {
    if (error instanceof ConnectorConfigParseError) {
      return { status: 'failed', reason: 'invalid_config', detail: error.message }
    }
    return { status: 'failed', reason: 'invalid_config', detail: describe(error) }
  }

  const changes = describePrivacyCatalogChanges(base, next)
  if (changes.length === 0) return { status: 'no_change', catalogVersion: patch.catalog_version }
  return {
    status: 'applied',
    catalogVersion: patch.catalog_version,
    config: next,
    changes,
    warnings: reviewPrivacyCatalogDeclarations(catalog).map(
      (warning) => `${warning.field}: ${warning.reason}`,
    ),
  }
}

/**
 * A `privacy` blokk platform-oldali extrái (pl. `resolve_path`, `catalog_path`)
 * nem a katalógusból jönnek — a capability-deklaráció felülírásakor megmaradnak.
 */
function readPrivacyExtras(config: Record<string, unknown>): Record<string, unknown> {
  const privacy = config.privacy
  if (!privacy || typeof privacy !== 'object' || Array.isArray(privacy)) return {}
  const extras: Record<string, unknown> = {}
  for (const key of ['resolve_path', 'catalog_path']) {
    const value = (privacy as Record<string, unknown>)[key]
    if (typeof value === 'string') extras[key] = value
  }
  return extras
}

/**
 * Egy connector teljes szinkronja: letöltés + validálás + összefésülés.
 * Nem ír DB-be és nem auditál — azt a hívó (service / script) végzi.
 */
export async function syncConnectorPrivacyCatalog(input: {
  connector: { type: string; config: unknown; secretAlias?: string | null }
  apiKey?: string
  resolveApiKey?: (secretAlias: string) => Promise<string>
  actingUserEmail?: string | null
  fetchCatalog?: PrivacyCatalogFetcher
}): Promise<PrivacyCatalogSyncOutcome> {
  if (input.connector.type !== 'http_api') {
    return {
      status: 'failed',
      reason: 'not_http_api',
      detail: 'a katalógus-szinkron csak http_api kapcsolaton értelmezhető',
    }
  }
  const fetcher = input.fetchCatalog ?? fetchConnectorPrivacyCatalog
  const fetched = await fetcher({
    config: input.connector.config,
    apiKey: input.apiKey,
    resolveApiKey: input.resolveApiKey,
    actingUserEmail: input.actingUserEmail,
  })
  if (!fetched.ok) return { status: 'failed', reason: fetched.reason, detail: fetched.detail }
  return applyPrivacyCatalogToConfig(input.connector.config, fetched.catalog)
}
