import {
  MODEL_PROVIDERS,
  type ModelOption,
  type ModelProviderOption,
  providerOption,
} from '@/lib/model-providers'

export const MODEL_POLICY_KEY = 'model.policy'

export type ModelPolicyEntry = {
  provider: string
  model: string
  enabled: boolean
  label?: string
  description?: string
  custom?: boolean
  updatedById?: string | null
  updatedAt?: string | null
}

export type ModelPolicy = {
  entries: ModelPolicyEntry[]
  updatedById: string | null
  updatedAt: string | null
}

export type ModelPolicyInput = {
  provider: string
  model: string
  enabled: boolean
  label?: string
  description?: string
}

function keyOf(provider: string, model: string): string {
  return `${provider.trim()}:${model.trim()}`
}

function defaultEntries(): ModelPolicyEntry[] {
  return MODEL_PROVIDERS.flatMap((provider) => {
    const models = provider.models?.length
      ? provider.models
      : [{ id: provider.defaultModel, label: provider.defaultModel }]
    return models.map((model) => ({
      provider: provider.value,
      model: model.id,
      label: model.label,
      description: model.description,
      enabled: provider.value !== 'openrouter',
      custom: false,
      updatedById: null,
      updatedAt: null,
    }))
  })
}

export function normalizeModelPolicy(raw: unknown): ModelPolicy {
  const defaults = defaultEntries()
  const byKey = new Map(defaults.map((entry) => [keyOf(entry.provider, entry.model), entry]))

  const rawObject = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const rawEntries = Array.isArray(rawObject.entries) ? rawObject.entries : []
  for (const item of rawEntries) {
    if (!item || typeof item !== 'object') continue
    const value = item as Partial<ModelPolicyEntry>
    if (typeof value.provider !== 'string' || typeof value.model !== 'string') continue
    const provider = value.provider.trim()
    const model = value.model.trim()
    if (!provider || !model) continue
    const existing = byKey.get(keyOf(provider, model))
    byKey.set(keyOf(provider, model), {
      provider,
      model,
      label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : existing?.label ?? model,
      description:
        typeof value.description === 'string' && value.description.trim()
          ? value.description.trim()
          : existing?.description,
      enabled: typeof value.enabled === 'boolean' ? value.enabled : existing?.enabled ?? false,
      custom: existing?.custom ?? value.custom === true,
      updatedById: typeof value.updatedById === 'string' ? value.updatedById : existing?.updatedById ?? null,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : existing?.updatedAt ?? null,
    })
  }

  return {
    entries: [...byKey.values()].sort((a, b) =>
      a.provider === b.provider ? a.model.localeCompare(b.model) : a.provider.localeCompare(b.provider),
    ),
    updatedById: typeof rawObject.updatedById === 'string' ? rawObject.updatedById : null,
    updatedAt: typeof rawObject.updatedAt === 'string' ? rawObject.updatedAt : null,
  }
}

export function serializeModelPolicy(policy: ModelPolicy): { entries: ModelPolicyEntry[]; updatedById: string | null; updatedAt: string | null } {
  return {
    entries: policy.entries.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      enabled: entry.enabled,
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.custom ? { custom: true } : {}),
      ...(entry.updatedById ? { updatedById: entry.updatedById } : {}),
      ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    })),
    updatedById: policy.updatedById,
    updatedAt: policy.updatedAt,
  }
}

export function upsertModelPolicyEntry(
  policy: ModelPolicy,
  input: ModelPolicyInput,
  actorId: string,
): ModelPolicy {
  const provider = input.provider.trim()
  const model = input.model.trim()
  const updatedAt = new Date().toISOString()
  const nextEntries = [...policy.entries]
  const index = nextEntries.findIndex((entry) => entry.provider === provider && entry.model === model)
  const providerMeta = providerOption(provider)
  const staticModel = providerMeta.models?.find((candidate) => candidate.id === model)
  const entry: ModelPolicyEntry = {
    provider,
    model,
    label: input.label?.trim() || staticModel?.label || model,
    description: input.description?.trim() || staticModel?.description,
    enabled: input.enabled,
    custom: !staticModel,
    updatedById: actorId,
    updatedAt,
  }

  if (index >= 0) {
    nextEntries[index] = { ...nextEntries[index], ...entry }
  } else {
    nextEntries.push(entry)
  }

  return normalizeModelPolicy({ entries: nextEntries, updatedById: actorId, updatedAt })
}

export function isModelAllowed(policy: ModelPolicy, provider: string, model: string): boolean {
  return policy.entries.some(
    (entry) => entry.provider === provider && entry.model === model && entry.enabled,
  )
}

export function assertModelAllowed(policy: ModelPolicy, provider: string, model: string): void {
  if (!isModelAllowed(policy, provider, model)) {
    throw new Error(`Model is not enabled for agents: ${provider}/${model}`)
  }
}

export function enabledModelProviders(policy: ModelPolicy): ModelProviderOption[] {
  return MODEL_PROVIDERS.reduce<ModelProviderOption[]>((acc, provider) => {
    const enabledModels = policy.entries
      .filter((entry) => entry.provider === provider.value && entry.enabled)
      .map<ModelOption>((entry) => ({
        id: entry.model,
        label: entry.label || entry.model,
        description: entry.description,
      }))

    if (enabledModels.length === 0) return acc
    const defaultModel = enabledModels.some((model) => model.id === provider.defaultModel)
      ? provider.defaultModel
      : enabledModels[0].id
    acc.push({ ...provider, defaultModel, models: enabledModels })
    return acc
  }, [])
}
