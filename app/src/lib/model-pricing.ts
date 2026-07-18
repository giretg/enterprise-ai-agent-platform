/**
 * Model pricing — D11 + háromrétegű tarifa (#34 / #43).
 *
 * Rétegek (gyengétől erősig): beépített alap → szinkronizált → kézi felülírás.
 * A meglévő `model.pricing` beállítás visszafelé kompatibilisen a **kézi** réteg.
 *
 * Fogyasztók: (a) gateway `costEstimate`, (b) szimuláció heurisztika.
 * Egység: EUR / 1M token.
 */
import { z } from 'zod'

/** Kézi felülírás réteg (ember írja). Visszafelé kompatibilis a régi egyrétegű kulccsal. */
export const MODEL_PRICING_SETTING_KEY = 'model.pricing' as const
/** Szinkronizált réteg (gép írja az ár-szinkron művelettel). */
export const MODEL_PRICING_SYNCED_SETTING_KEY = 'model.pricing.synced' as const
/** Szinkron meta (árfolyam, dátum, forrás-ujjlenyomat) — megjelenítéshez. */
export const MODEL_PRICING_SYNC_META_KEY = 'model.pricing.sync_meta' as const

export const modelPriceSchema = z.object({
  inputPerMTokens: z.number().min(0),
  outputPerMTokens: z.number().min(0),
})
export type ModelPrice = z.infer<typeof modelPriceSchema>

/** modelId → ár. A `default` kulcs a fallback ismeretlen modellhez. */
export const modelPricingTableSchema = z.record(z.string(), modelPriceSchema)
export type ModelPricingTable = z.infer<typeof modelPricingTableSchema>

export type PricingLayerSource = 'builtin' | 'synced' | 'manual'

export const modelPricingSyncMetaSchema = z.object({
  lastSyncedAt: z.string(),
  sourceFingerprint: z.string(),
  sourceLabel: z.string().optional(),
  eurPerUsd: z.number().positive(),
  rateAsOf: z.string(),
  modelCount: z.number().int().nonnegative().optional(),
})
export type ModelPricingSyncMeta = z.infer<typeof modelPricingSyncMetaSchema>

/**
 * Beépített default tarifa (EUR / 1M token, közelítő). A publikus USD-listaárak EUR-ra
 * konvertált, kerekített becslése. A cél: a costEstimate determinisztikusan NE legyen 0.
 */
export const DEFAULT_MODEL_PRICING: ModelPricingTable = {
  'claude-opus-4-8': { inputPerMTokens: 14, outputPerMTokens: 70 },
  'claude-opus': { inputPerMTokens: 14, outputPerMTokens: 70 },
  'claude-sonnet-5': { inputPerMTokens: 2.8, outputPerMTokens: 14 },
  'claude-sonnet': { inputPerMTokens: 2.8, outputPerMTokens: 14 },
  'claude-haiku-4-5': { inputPerMTokens: 0.75, outputPerMTokens: 3.7 },
  'claude-haiku': { inputPerMTokens: 0.75, outputPerMTokens: 3.7 },
  'gpt-4o': { inputPerMTokens: 2.3, outputPerMTokens: 9.2 },
  default: { inputPerMTokens: 2.8, outputPerMTokens: 14 },
}

/** A `default` kulcs mindig értelmes, nem nulla árat ad. */
export const BUILTIN_DEFAULT_PRICE: ModelPrice = { inputPerMTokens: 2.8, outputPerMTokens: 14 }

/**
 * Három réteg összefésülése: builtin ← synced ← manual.
 * A felső réteg kulcsonként felülírja az alsót.
 */
export function mergePricingLayers(input: {
  builtin?: ModelPricingTable
  synced?: ModelPricingTable | null
  manual?: ModelPricingTable | null
}): ModelPricingTable {
  return {
    ...(input.builtin ?? DEFAULT_MODEL_PRICING),
    ...(input.synced ?? {}),
    ...(input.manual ?? {}),
  }
}

/** Melyik réteg adta az adott kulcs árát (pontos kulcsra). */
export function pricingLayerForKey(
  key: string,
  layers: {
    builtin: ModelPricingTable
    synced?: ModelPricingTable | null
    manual?: ModelPricingTable | null
  },
): PricingLayerSource {
  if (layers.manual && Object.prototype.hasOwnProperty.call(layers.manual, key)) return 'manual'
  if (layers.synced && Object.prototype.hasOwnProperty.call(layers.synced, key)) return 'synced'
  return 'builtin'
}

/** A modellhez tartozó ár: pontos kulcs → leghosszabb prefix-kulcs → `default`. */
export function resolveModelPrice(model: string, table: ModelPricingTable): ModelPrice {
  return resolveModelPriceWithSource(model, table).price
}

export function resolveModelPriceWithSource(
  model: string,
  table: ModelPricingTable,
): { price: ModelPrice; matchedKey: string } {
  if (table[model]) return { price: table[model]!, matchedKey: model }
  let best: { key: string; price: ModelPrice } | null = null
  for (const [key, price] of Object.entries(table)) {
    if (key === 'default') continue
    if (model.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, price }
    }
  }
  if (best) return { price: best.price, matchedKey: best.key }
  const fallback = table.default ?? BUILTIN_DEFAULT_PRICE
  // Ismeretlen modell soha ne kapjon nullát — a builtin default él.
  const safe =
    fallback.inputPerMTokens === 0 && fallback.outputPerMTokens === 0
      ? BUILTIN_DEFAULT_PRICE
      : fallback
  return { price: safe, matchedKey: 'default' }
}

/**
 * A modell-hívás becsült költsége EUR-ban a token-számokból. A tarifa-tábla hiánya esetén
 * a beépített default él (nem 0). Négy tizedesre kerekít.
 */
export function computeModelCostEur(
  model: string,
  promptTokens: number,
  completionTokens: number,
  table: ModelPricingTable = DEFAULT_MODEL_PRICING,
): number {
  const price = resolveModelPrice(model, table)
  const cost =
    (Math.max(0, promptTokens) * price.inputPerMTokens) / 1_000_000 +
    (Math.max(0, completionTokens) * price.outputPerMTokens) / 1_000_000
  return Math.round(cost * 10000) / 10000
}

/** Egyetlen tábla parse — hibás/hiányzó → null (a hívó dönt a merge-ről). */
export function parsePricingTableOrNull(raw: unknown): ModelPricingTable | null {
  if (raw == null) return null
  const parsed = modelPricingTableSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * Platform-setting parse + merge a defaultra.
 * Visszafelé kompatibilis: a régi egyrétegű `model.pricing` kézi rétegként él tovább.
 * Hibás setting → default (nem dob).
 */
export function parseModelPricingSetting(raw: unknown): ModelPricingTable {
  const manual = parsePricingTableOrNull(raw)
  if (!manual) return DEFAULT_MODEL_PRICING
  return mergePricingLayers({ builtin: DEFAULT_MODEL_PRICING, manual })
}

/** Három réteg betöltése settings-ből. Hibás/hiányzó → builtin érvényben, nincs throw. */
export function resolvePricingFromSettings(raw: {
  manual?: unknown
  synced?: unknown
}): ModelPricingTable {
  return mergePricingLayers({
    builtin: DEFAULT_MODEL_PRICING,
    synced: parsePricingTableOrNull(raw.synced),
    manual: parsePricingTableOrNull(raw.manual),
  })
}

export function parseModelPricingSyncMeta(raw: unknown): ModelPricingSyncMeta | null {
  if (raw == null) return null
  const parsed = modelPricingSyncMetaSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
