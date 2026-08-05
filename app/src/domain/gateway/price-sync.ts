/**
 * Ár-szinkron művelet (Seam 2) — ár-pillanatkép → EUR / 1M token.
 *
 * Források:
 * - OpenRouter `GET /api/v1/models` (böngészős gomb / élő frissítés)
 * - Repo LiteLLM-stílusú fixture (CLI / offline)
 *
 * Alapállás: dry-run (csak diff). Íráshoz `dryRun: false`.
 */

import { createHash } from 'node:crypto'
import type { AuditRepository, PlatformSettingsRepository } from '@/repositories/interfaces'
import {
  BUILTIN_DEFAULT_PRICE,
  DEFAULT_MODEL_PRICING,
  MODEL_PRICING_SYNC_META_KEY,
  MODEL_PRICING_SYNCED_SETTING_KEY,
  mergePricingLayers,
  parsePricingTableOrNull,
  type ModelPrice,
  type ModelPricingTable,
} from '@/lib/model-pricing'
import repoPriceSnapshotJson from '../../../scripts/fixtures/model-pricing/litellm-price-snapshot.json'

/** Repo-beli ár-pillanatkép címkéje (CLI offline forrás). */
export const REPO_PRICE_SNAPSHOT_LABEL =
  'scripts/fixtures/model-pricing/litellm-price-snapshot.json' as const

/** OpenRouter élő models API forráscímke (sync meta + audit). */
export const OPENROUTER_PRICE_SOURCE_LABEL = 'openrouter:/api/v1/models' as const

/** Rögzített EUR/USD árfolyam alapértelmezés (reprodukálható költség). */
export const DEFAULT_EUR_PER_USD = 0.92

/**
 * Forrásmodell-név → kanonikus modell-azonosító.
 * A hosszabb előtagok előbb illeszkednek.
 */
export const DEFAULT_MODEL_NAME_MAP: Array<{ sourcePrefix: string; canonical: string }> = [
  { sourcePrefix: 'claude-3-5-sonnet', canonical: 'claude-sonnet' },
  { sourcePrefix: 'claude-3-7-sonnet', canonical: 'claude-sonnet' },
  { sourcePrefix: 'claude-sonnet-4', canonical: 'claude-sonnet' },
  { sourcePrefix: 'claude-opus-4', canonical: 'claude-opus' },
  { sourcePrefix: 'claude-3-opus', canonical: 'claude-opus' },
  { sourcePrefix: 'claude-3-haiku', canonical: 'claude-haiku' },
  { sourcePrefix: 'claude-haiku', canonical: 'claude-haiku' },
  { sourcePrefix: 'gpt-4o', canonical: 'gpt-4o' },
  { sourcePrefix: 'gpt-4', canonical: 'gpt-4o' },
]

export type PriceSnapshotEntry = {
  /** Forrás modellnév (pl. LiteLLM / OpenRouter kulcs). */
  model: string
  /** USD / token (input). */
  inputCostPerToken?: number
  /** USD / token (output). */
  outputCostPerToken?: number
}

/** Beágyazott repo-pillanatkép — offline CLI / tesztek. */
export function getRepoPriceSnapshot(): PriceSnapshotEntry[] {
  return repoPriceSnapshotJson as PriceSnapshotEntry[]
}

function parseUsdPerToken(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return null
}

/**
 * OpenRouter publikus models lista → ár-pillanatkép (USD / token).
 * Auth opcionális; a `/models` végpont kulcs nélkül is válaszol.
 */
export async function fetchOpenRouterPriceSnapshot(opts: {
  baseUrl?: string
  apiKey?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
} = {}): Promise<PriceSnapshotEntry[]> {
  const base = (opts.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(
    /\/$/,
    '',
  )
  const url = `${base}/models`
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? undefined
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 20_000

  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(process.env.OPENROUTER_HTTP_REFERER
        ? { 'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER }
        : {}),
      ...(process.env.OPENROUTER_APP_TITLE
        ? { 'X-OpenRouter-Title': process.env.OPENROUTER_APP_TITLE }
        : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`openrouter_models_http_${response.status}`)
  }

  const body: unknown = await response.json()
  const data = Array.isArray((body as { data?: unknown })?.data)
    ? ((body as { data: unknown[] }).data)
    : Array.isArray(body)
      ? body
      : null
  if (!data) {
    throw new Error('openrouter_models_invalid_payload')
  }

  const snapshot: PriceSnapshotEntry[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const row = item as {
      id?: unknown
      pricing?: {
        prompt?: unknown
        completion?: unknown
        discount?: unknown
      }
    }
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (!id) continue
    const pricing = row.pricing
    if (!pricing || typeof pricing !== 'object') continue

    const discountRaw = pricing.discount
    const discount =
      typeof discountRaw === 'number' && Number.isFinite(discountRaw)
        ? Math.min(1, Math.max(0, discountRaw))
        : 0
    const factor = 1 - discount

    const prompt = parseUsdPerToken(pricing.prompt)
    const completion = parseUsdPerToken(pricing.completion)
    if (prompt === null && completion === null) continue

    snapshot.push({
      model: id,
      ...(prompt !== null ? { inputCostPerToken: prompt * factor } : {}),
      ...(completion !== null ? { outputCostPerToken: completion * factor } : {}),
    })
  }

  if (snapshot.length === 0) {
    throw new Error('openrouter_models_empty_pricing')
  }

  return snapshot
}

export type PriceSyncDiffEntry = {
  model: string
  before: ModelPrice | null
  after: ModelPrice
  changed: boolean
}

export type PriceSyncResult = {
  ok: boolean
  dryRun: boolean
  fingerprint: string
  eurPerUsd: number
  rateAsOf: string
  diffs: PriceSyncDiffEntry[]
  written: number
  error?: string
}

function fingerprintOf(snapshot: PriceSnapshotEntry[]): string {
  const normalized = JSON.stringify(
    [...snapshot].sort((a, b) => a.model.localeCompare(b.model)),
  )
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

export function mapSourceModelName(
  sourceName: string,
  map: Array<{ sourcePrefix: string; canonical: string }> = DEFAULT_MODEL_NAME_MAP,
): string | null {
  const lower = sourceName.toLowerCase()
  let best: { prefix: string; canonical: string } | null = null
  for (const entry of map) {
    const prefix = entry.sourcePrefix.toLowerCase()
    if (lower === prefix || lower.startsWith(prefix)) {
      if (!best || prefix.length > best.prefix.length) {
        best = { prefix, canonical: entry.canonical }
      }
    }
  }
  return best?.canonical ?? null
}

/**
 * OpenRouter modell-id → platform (közvetlen / beépített) tarifakulcs-aliasok.
 *
 * - Gemini: `google/gemini-…` → `gemini-…` (közvetlen Google provider id)
 * - Claude: `anthropic/claude-…` → normalizált + család-kulcsok (`claude-sonnet`, …)
 */
export function openRouterLocalModelAliases(sourceId: string): string[] {
  const id = sourceId.trim()
  if (!id) return []
  const bare = id.startsWith('~') ? id.slice(1) : id
  const aliases: string[] = []

  if (bare.startsWith('google/')) {
    const local = bare.slice('google/'.length)
    if (local.startsWith('gemini')) aliases.push(local)
  }

  if (bare.startsWith('anthropic/')) {
    const local = bare.slice('anthropic/'.length)
    if (local.startsWith('claude')) {
      // OR: claude-haiku-4.5 → platform: claude-haiku-4-5
      const normalized = local.replace(/\./g, '-')
      aliases.push(...anthropicClaudePlatformAliases(normalized))
    }
  }

  return [...new Set(aliases)]
}

/**
 * Preferált OpenRouter Claude slugok → a UI / builtin által használt kulcsok.
 * Régi verziók (pl. sonnet-4) csak a saját normalizált id-t kapják, ne írják felül
 * a család-alias aktuális árát.
 */
function anthropicClaudePlatformAliases(normalized: string): string[] {
  const out = new Set<string>([normalized])

  if (normalized === 'claude-haiku-4-5' || normalized === 'claude-haiku-latest') {
    out.add('claude-haiku-4-5')
    out.add('claude-haiku')
  } else if (normalized === 'claude-sonnet-5' || normalized === 'claude-sonnet-latest') {
    out.add('claude-sonnet-5')
    out.add('claude-sonnet')
  } else if (normalized === 'claude-opus-4-8' || normalized === 'claude-opus-latest') {
    out.add('claude-opus-4-8')
    out.add('claude-opus')
  }

  return [...out]
}

/** $ / token → € / 1M token. */
export function usdPerTokenToEurPerM(
  usdPerToken: number,
  eurPerUsd: number,
): number {
  const eurPerM = usdPerToken * 1_000_000 * eurPerUsd
  return Math.round(eurPerM * 10000) / 10000
}

export function convertSnapshotToPricingTable(
  snapshot: PriceSnapshotEntry[],
  opts: {
    eurPerUsd?: number
    nameMap?: Array<{ sourcePrefix: string; canonical: string }>
    /**
     * OpenRouter: a forrás modell-id a tarifakulcs.
     * Emellett a nameMap találatai és a provider-aliasok is beíródnak
     * (`google/gemini-…` → `gemini-…`, `anthropic/claude-…` → `claude-…`).
     */
    keepSourceIds?: boolean
  } = {},
): ModelPricingTable {
  const eurPerUsd = opts.eurPerUsd ?? DEFAULT_EUR_PER_USD
  const nameMap = opts.nameMap ?? DEFAULT_MODEL_NAME_MAP
  const keepSourceIds = opts.keepSourceIds === true
  const table: ModelPricingTable = {}

  for (const entry of snapshot) {
    const keys: string[] = []
    if (keepSourceIds) {
      keys.push(entry.model)
      for (const alias of openRouterLocalModelAliases(entry.model)) {
        if (!keys.includes(alias)) keys.push(alias)
      }
    }
    const canonical = mapSourceModelName(entry.model, nameMap)
    if (canonical && !keys.includes(canonical)) keys.push(canonical)
    if (keys.length === 0) continue

    const input =
      typeof entry.inputCostPerToken === 'number'
        ? usdPerTokenToEurPerM(entry.inputCostPerToken, eurPerUsd)
        : BUILTIN_DEFAULT_PRICE.inputPerMTokens
    const output =
      typeof entry.outputCostPerToken === 'number'
        ? usdPerTokenToEurPerM(entry.outputCostPerToken, eurPerUsd)
        : BUILTIN_DEFAULT_PRICE.outputPerMTokens
    const price = { inputPerMTokens: input, outputPerMTokens: output }
    // Ugyanarra a kulcsra több forrás → utolsó nyer (pillanatkép sorrend).
    for (const key of keys) {
      table[key] = price
    }
  }

  return table
}

function pricesEqual(a: ModelPrice | null | undefined, b: ModelPrice): boolean {
  if (!a) return false
  return a.inputPerMTokens === b.inputPerMTokens && a.outputPerMTokens === b.outputPerMTokens
}

const AUDIT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function auditUuidOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  return AUDIT_UUID_RE.test(value) ? value : null
}

/**
 * Tiszta szinkron függvény: forrás-pillanatkép + árfolyam + settings → diff.
 * Hibás/hiányzó forrásnál nem dob — `ok: false`, a beépített alap marad.
 */
export async function syncModelPricing(input: {
  snapshot: PriceSnapshotEntry[] | null | undefined
  settings: Pick<PlatformSettingsRepository, 'get' | 'set'>
  audit?: Pick<AuditRepository, 'append'>
  actorId?: string
  /** Alapból true — csak diff, nem ír. */
  dryRun?: boolean
  eurPerUsd?: number
  rateAsOf?: string
  sourceLabel?: string
  nameMap?: Array<{ sourcePrefix: string; canonical: string }>
  keepSourceIds?: boolean
}): Promise<PriceSyncResult> {
  const dryRun = input.dryRun !== false
  const eurPerUsd = input.eurPerUsd ?? DEFAULT_EUR_PER_USD
  const rateAsOf = input.rateAsOf ?? new Date().toISOString().slice(0, 10)

  if (!input.snapshot || !Array.isArray(input.snapshot) || input.snapshot.length === 0) {
    return {
      ok: false,
      dryRun,
      fingerprint: '',
      eurPerUsd,
      rateAsOf,
      diffs: [],
      written: 0,
      error: 'missing_or_empty_snapshot',
    }
  }

  let proposed: ModelPricingTable
  try {
    proposed = convertSnapshotToPricingTable(input.snapshot, {
      eurPerUsd,
      nameMap: input.nameMap,
      keepSourceIds: input.keepSourceIds,
    })
  } catch {
    return {
      ok: false,
      dryRun,
      fingerprint: '',
      eurPerUsd,
      rateAsOf,
      diffs: [],
      written: 0,
      error: 'snapshot_convert_failed',
    }
  }

  if (Object.keys(proposed).length === 0) {
    return {
      ok: false,
      dryRun,
      fingerprint: fingerprintOf(input.snapshot),
      eurPerUsd,
      rateAsOf,
      diffs: [],
      written: 0,
      error: 'snapshot_mapped_empty',
    }
  }

  const fingerprint = fingerprintOf(input.snapshot)
  let currentSynced: ModelPricingTable = {}
  try {
    currentSynced = parsePricingTableOrNull(await input.settings.get(MODEL_PRICING_SYNCED_SETTING_KEY)) ?? {}
  } catch {
    currentSynced = {}
  }

  const effectiveBefore = mergePricingLayers({
    builtin: DEFAULT_MODEL_PRICING,
    synced: currentSynced,
  })

  const diffs: PriceSyncDiffEntry[] = []
  const keys = new Set([...Object.keys(proposed), ...Object.keys(currentSynced)])
  for (const model of [...keys].sort()) {
    if (model === 'default') continue
    const after = proposed[model]
    if (!after) continue
    // Effektív „előtte” ár (builtin ∪ synced) — ne tűnjön nullának, ha csak a beépített van.
    const before = effectiveBefore[model] ?? currentSynced[model] ?? null
    diffs.push({
      model,
      before,
      after,
      changed: !pricesEqual(before, after),
    })
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      fingerprint,
      eurPerUsd,
      rateAsOf,
      diffs,
      written: 0,
    }
  }

  await input.settings.set(MODEL_PRICING_SYNCED_SETTING_KEY, proposed, input.actorId ?? null)
  await input.settings.set(
    MODEL_PRICING_SYNC_META_KEY,
    {
      lastSyncedAt: new Date().toISOString(),
      sourceFingerprint: fingerprint,
      sourceLabel: input.sourceLabel ?? 'repo-snapshot',
      eurPerUsd,
      rateAsOf,
      modelCount: Object.keys(proposed).length,
    },
    input.actorId ?? null,
  )

  if (input.audit) {
    await input.audit.append({
      actorType: 'system',
      actorId: auditUuidOrNull(input.actorId),
      agentVersion: null,
      action: 'model.pricing.sync',
      targetType: 'platform_setting',
      // target_id DB-ben UUID — a setting kulcs a metadata-ba kerül.
      targetId: null,
      modelUsed: null,
      inputRef: fingerprint,
      outputRef: `models:${Object.keys(proposed).length}`,
      policyDecision: 'synced',
      metadata: {
        settingKey: MODEL_PRICING_SYNCED_SETTING_KEY,
        actorLabel: input.actorId ?? 'price-sync',
        modelCount: Object.keys(proposed).length,
        changedCount: diffs.filter((d) => d.changed).length,
        sourceFingerprint: fingerprint,
        sourceLabel: input.sourceLabel ?? 'repo-snapshot',
        eurPerUsd,
        rateAsOf,
        // effectiveBefore csak audit-nyomhoz — a kézi réteg érintetlen
        sampleBefore: Object.keys(effectiveBefore).slice(0, 3),
      },
    })
  }

  return {
    ok: true,
    dryRun: false,
    fingerprint,
    eurPerUsd,
    rateAsOf,
    diffs,
    written: Object.keys(proposed).length,
  }
}
