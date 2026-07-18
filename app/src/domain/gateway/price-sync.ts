/**
 * Ár-szinkron művelet (Seam 2) — LiteLLM-stílusú publikus ár-pillanatkép → EUR / 1M token.
 *
 * Alapállás: dry-run (csak diff). Íráshoz `write: true`.
 * Nincs hálózat a fő úton — a forrás injektált pillanatkép.
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
  /** Forrás modellnév (pl. LiteLLM kulcs). */
  model: string
  /** USD / token (input). */
  inputCostPerToken?: number
  /** USD / token (output). */
  outputCostPerToken?: number
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
  } = {},
): ModelPricingTable {
  const eurPerUsd = opts.eurPerUsd ?? DEFAULT_EUR_PER_USD
  const nameMap = opts.nameMap ?? DEFAULT_MODEL_NAME_MAP
  const table: ModelPricingTable = {}

  for (const entry of snapshot) {
    const canonical = mapSourceModelName(entry.model, nameMap)
    if (!canonical) continue
    const input =
      typeof entry.inputCostPerToken === 'number'
        ? usdPerTokenToEurPerM(entry.inputCostPerToken, eurPerUsd)
        : BUILTIN_DEFAULT_PRICE.inputPerMTokens
    const output =
      typeof entry.outputCostPerToken === 'number'
        ? usdPerTokenToEurPerM(entry.outputCostPerToken, eurPerUsd)
        : BUILTIN_DEFAULT_PRICE.outputPerMTokens
    // Ugyanarra a kanonikusra több forrás → utolsó nyer (pillanatkép sorrend).
    table[canonical] = { inputPerMTokens: input, outputPerMTokens: output }
  }

  return table
}

function pricesEqual(a: ModelPrice | null | undefined, b: ModelPrice): boolean {
  if (!a) return false
  return a.inputPerMTokens === b.inputPerMTokens && a.outputPerMTokens === b.outputPerMTokens
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
      actorId: input.actorId ?? 'price-sync',
      agentVersion: null,
      action: 'model.pricing.sync',
      targetType: 'platform_setting',
      targetId: MODEL_PRICING_SYNCED_SETTING_KEY,
      modelUsed: null,
      inputRef: fingerprint,
      outputRef: `models:${Object.keys(proposed).length}`,
      policyDecision: 'synced',
      metadata: {
        modelCount: Object.keys(proposed).length,
        changedCount: diffs.filter((d) => d.changed).length,
        sourceFingerprint: fingerprint,
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
