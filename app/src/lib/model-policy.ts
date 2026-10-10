import { MODEL_PROVIDERS, MODEL_PROVIDER_IDS, type ModelProviderId } from '@/lib/model-providers'

/** Egy konkrét modell: melyik forrásból (provider) és melyik néven. */
export type ModelRef = { provider: ModelProviderId; model: string }

/**
 * Tenant engedett modell-lista (#768). Csak az admin által bekapcsolt modellek szerepelnek benne;
 * üres lista = egyetlen agent sem kaphat modellt (explicit üres állapot a UI-n).
 */
export type ModelPolicy = { enabled: ModelRef[] }

export const EMPTY_MODEL_POLICY: ModelPolicy = { enabled: [] }

const providerIds: ReadonlySet<string> = new Set(MODEL_PROVIDER_IDS)

export function isModelProviderId(value: unknown): value is ModelProviderId {
  return typeof value === 'string' && providerIds.has(value)
}

export function modelRefKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`
}

export function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.provider === b.provider && a.model === b.model
}

/** Ismeretlen provider / hibás alak kiesik; a duplikátum összevonódik. */
export function parseModelRefs(raw: unknown): ModelRef[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: ModelRef[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { provider, model } = item as Record<string, unknown>
    if (!isModelProviderId(provider) || typeof model !== 'string' || !model.trim()) continue
    const ref = { provider, model: model.trim() }
    if (seen.has(modelRefKey(ref))) continue
    seen.add(modelRefKey(ref))
    out.push(ref)
  }
  return out
}

export function parseModelPolicy(raw: unknown): ModelPolicy {
  const enabled = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).enabled : null
  return { enabled: parseModelRefs(enabled) }
}

export function isModelAllowed(policy: ModelPolicy, ref: ModelRef): boolean {
  return policy.enabled.some((entry) => sameModel(entry, ref))
}

export function setModelEnabled(policy: ModelPolicy, ref: ModelRef, enabled: boolean): ModelPolicy {
  const rest = policy.enabled.filter((entry) => !sameModel(entry, ref))
  return { enabled: enabled ? [...rest, ref] : rest }
}

export type ModelCatalogEntry = ModelRef & { label: string; description?: string; enabled: boolean }

/** A beépített katalógus + az engedélyezett egyedi modellek, forrásonként csoportosításra készen. */
export function modelCatalog(policy: ModelPolicy): ModelCatalogEntry[] {
  const rows: ModelCatalogEntry[] = []
  for (const provider of MODEL_PROVIDERS) {
    const builtin = provider.models ?? []
    for (const m of builtin) {
      const ref = { provider: provider.value as ModelProviderId, model: m.id }
      rows.push({ ...ref, label: m.label, description: m.description, enabled: isModelAllowed(policy, ref) })
    }
    for (const ref of policy.enabled) {
      if (ref.provider === provider.value && !builtin.some((m) => m.id === ref.model)) {
        rows.push({ ...ref, label: ref.model, enabled: true })
      }
    }
  }
  return rows
}

export function modelDisplayName(ref: ModelRef): string {
  const provider = MODEL_PROVIDERS.find((p) => p.value === ref.provider)
  const label = provider?.models?.find((m) => m.id === ref.model)?.label ?? ref.model
  return `${label} (${provider?.label ?? ref.provider})`
}
