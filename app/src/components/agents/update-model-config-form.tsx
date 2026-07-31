'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentModelConfig } from '@/app/actions/platform'
import { ModelSelectField } from '@/components/agents/model-select-field'
import { ModelTypeSelectField } from '@/components/agents/model-type-select-field'
import { Card } from '@/components/ui/shell'
import {
  DEFAULT_MODEL_TYPE,
  MODEL_PROVIDERS,
  isModelType,
  normalizeModelForProvider,
  providerOption,
  type ModelProviderOption,
  type ModelType,
} from '@/lib/model-providers'

type FallbackRow = { provider: string; model: string }

// Admin agentenként módosíthatja a modell-konfigot (provider/model/modelType/
// temperature/maxTokens/fallbackModels). Minden mentés új agent-verziót fagyaszt be.
export function UpdateModelConfigForm({
  agentId,
  current,
  providers = MODEL_PROVIDERS,
}: {
  agentId: string
  current: {
    provider: string
    model: string
    modelType?: ModelType
    temperature?: number
    maxTokens?: number
    fallbackModels?: FallbackRow[]
  }
  providers?: ModelProviderOption[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [provider, setProvider] = useState(current.provider)
  const [model, setModel] = useState(current.model)
  const [modelType, setModelType] = useState<ModelType>(
    current.modelType && isModelType(current.modelType) ? current.modelType : DEFAULT_MODEL_TYPE,
  )
  const [fallbacksOpen, setFallbacksOpen] = useState(
    (current.fallbackModels?.length ?? 0) > 0,
  )
  const [fallbacks, setFallbacks] = useState<FallbackRow[]>(current.fallbackModels ?? [])
  const [fbProvider, setFbProvider] = useState(MODEL_PROVIDERS[0]?.value ?? 'ollama')
  const [fbModel, setFbModel] = useState(MODEL_PROVIDERS[0]?.defaultModel ?? '')

  const safeProviders = providers.length > 0 ? providers : MODEL_PROVIDERS
  const uniqueProviders = safeProviders.filter(
    (option, index, allProviders) =>
      allProviders.findIndex((candidate) => candidate.value === option.value) === index,
  )
  const providerOptions = uniqueProviders.some((p) => p.value === current.provider)
    ? uniqueProviders
    : [
        ...uniqueProviders,
        {
          ...providerOption(current.provider),
          defaultModel: current.model,
          models: [{ id: current.model, label: `${current.model} (jelenlegi)` }],
        },
      ]

  const selected = providerOption(provider, providerOptions)
  const fallbacksEqual =
    JSON.stringify(fallbacks) === JSON.stringify(current.fallbackModels ?? [])
  const currentType: ModelType =
    current.modelType && isModelType(current.modelType) ? current.modelType : DEFAULT_MODEL_TYPE
  const unchanged =
    provider === current.provider &&
    model.trim() === current.model &&
    modelType === currentType &&
    fallbacksEqual

  return (
    <Card title="Gondolkodási motor beállítása">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          const fd = new FormData(e.currentTarget)
          const temperature = Number(fd.get('temperature'))
          const maxTokens = Number(fd.get('maxTokens'))
          startTransition(async () => {
            setError(null)
            setDone(null)
            const res = await updateAgentModelConfig({
              agentId,
              modelConfig: {
                provider,
                model: normalizeModelForProvider(provider, model, providerOptions),
                modelType,
                ...(Number.isFinite(temperature) ? { temperature } : {}),
                ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
                ...(fallbacks.length > 0 ? { fallbackModels: fallbacks } : { fallbackModels: [] }),
              },
            })
            if (res.success) {
              setDone(
                `Agent v${res.data.agentVersion} — ${provider}/${model.trim() || selected.defaultModel} · ${modelType}`,
              )
              router.refresh()
            } else {
              setError(res.error)
            }
          })
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-ink-soft">Modellforrás (provider)</span>
            <select
              value={provider}
              onChange={(e) => {
                const next = providerOption(e.target.value, providerOptions)
                setProvider(next.value)
                setModel(normalizeModelForProvider(next.value, model, providerOptions))
              }}
              className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
            >
              {providerOptions.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Modell</span>
            <ModelSelectField
              provider={provider}
              model={model}
              onModelChange={setModel}
              providers={providerOptions}
            />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-ink-soft">Modell típus (gondolkodási profil)</span>
            <ModelTypeSelectField modelType={modelType} onModelTypeChange={setModelType} />
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Temperature</span>
            <input
              name="temperature"
              type="number"
              step="0.1"
              min={0}
              max={2}
              defaultValue={current.temperature ?? 0.2}
              className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Max tokens</span>
            <input
              name="maxTokens"
              type="number"
              min={1}
              defaultValue={current.maxTokens ?? 4096}
              className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
            />
          </label>
        </div>
        <p className="text-xs text-ink-faint">{selected.hint}</p>

        <div className="rounded-lg border border-line/50 bg-night/30 p-3">
          <button
            type="button"
            className="text-sm font-medium text-ink"
            onClick={() => setFallbacksOpen((v) => !v)}
          >
            {fallbacksOpen ? '▾' : '▸'} Tartalék modellek (opcionális)
          </button>
          {fallbacksOpen && (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-ink-soft">
                Az agent-szintű tartalék a <strong>globális lánc előtt</strong> lép működésbe.
                Mentéskor új agent-verzió fagy be. Futásidőben sem a kérés, sem az agent nem írhatja felül.
              </p>
              {fallbacks.map((f, i) => (
                <div key={`${f.provider}/${f.model}/${i}`} className="flex items-center justify-between text-sm">
                  <span className="text-ink">
                    {i + 1}. {f.provider}/{f.model}
                  </span>
                  <button
                    type="button"
                    className="text-xs text-coral"
                    onClick={() => setFallbacks((prev) => prev.filter((_, j) => j !== i))}
                  >
                    Töröl
                  </button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <select
                  value={fbProvider}
                  onChange={(e) => {
                    const p = MODEL_PROVIDERS.find((x) => x.value === e.target.value)
                    setFbProvider(e.target.value)
                    if (p) setFbModel(p.defaultModel)
                  }}
                  className="rounded border border-line bg-night-2 px-2 py-1 text-xs"
                >
                  {MODEL_PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <input
                  value={fbModel}
                  onChange={(e) => setFbModel(e.target.value)}
                  className="rounded border border-line bg-night-2 px-2 py-1 text-xs"
                  placeholder="model"
                />
                <button
                  type="button"
                  className="rounded border border-line px-2 py-1 text-xs"
                  onClick={() => {
                    if (!fbModel.trim()) return
                    setFallbacks((prev) => [...prev, { provider: fbProvider, model: fbModel.trim() }])
                  }}
                >
                  Hozzáad
                </button>
              </div>
            </div>
          )}
        </div>

        {error && <p className="text-sm text-coral">{error}</p>}
        {done && (
          <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
            Mentve: {done}
          </p>
        )}
        <button
          type="submit"
          disabled={pending || unchanged}
          className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
        >
          {pending ? 'Mentés...' : 'Új verzió mentése'}
        </button>
      </form>
    </Card>
  )
}
