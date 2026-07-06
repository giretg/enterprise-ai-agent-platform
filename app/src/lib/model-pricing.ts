/**
 * Model pricing — D11 (Governed Flow Builder spec §1 D11, §16.1).
 *
 * Egyetlen tarifa-forrás, KÉT fogyasztóval:
 *   (a) a VALÓDI gateway `costEstimate` — ami korábban FIXEN `0` volt (§16.1 lappangó hiba),
 *   (b) a szimuláció heurisztikus becslése (PlaybookSimulator, WP-4).
 *
 * Per-modell input/output ár EUR / 1M token (a measurement-report EUR-konvenciójához igazítva).
 * Platform-settingként felülírható (`model.pricing`); ha nincs, a beépített default tábla él,
 * hogy a költség NE maradjon 0.
 */
import { z } from 'zod'

export const MODEL_PRICING_SETTING_KEY = 'model.pricing' as const

export const modelPriceSchema = z.object({
  inputPerMTokens: z.number().min(0),
  outputPerMTokens: z.number().min(0),
})
export type ModelPrice = z.infer<typeof modelPriceSchema>

/** modelId → ár. A `default` kulcs a fallback ismeretlen modellhez. */
export const modelPricingTableSchema = z.record(z.string(), modelPriceSchema)
export type ModelPricingTable = z.infer<typeof modelPricingTableSchema>

/**
 * Beépített default tarifa (EUR / 1M token, közelítő). A publikus USD-listaárak EUR-ra
 * konvertált, kerekített becslése; platform-settinggel felülírható. A cél: a costEstimate
 * determinisztikusan NE legyen 0, amíg nincs finomhangolt tarifa.
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

/** A modellhez tartozó ár: pontos kulcs → leghosszabb prefix-kulcs → `default`. */
export function resolveModelPrice(model: string, table: ModelPricingTable): ModelPrice {
  if (table[model]) return table[model]!
  let best: { key: string; price: ModelPrice } | null = null
  for (const [key, price] of Object.entries(table)) {
    if (key === 'default') continue
    if (model.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, price }
    }
  }
  if (best) return best.price
  return table.default ?? { inputPerMTokens: 0, outputPerMTokens: 0 }
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

/** Platform-setting parse + merge a defaultra. Hibás setting → default (nem dob). */
export function parseModelPricingSetting(raw: unknown): ModelPricingTable {
  if (raw == null) return DEFAULT_MODEL_PRICING
  const parsed = modelPricingTableSchema.safeParse(raw)
  if (!parsed.success) return DEFAULT_MODEL_PRICING
  return { ...DEFAULT_MODEL_PRICING, ...parsed.data }
}
