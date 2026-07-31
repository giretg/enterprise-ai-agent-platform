'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { createAgent } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'
import { ModelSelectField } from '@/components/agents/model-select-field'
import { ModelTypeSelectField } from '@/components/agents/model-type-select-field'
import {
  DEFAULT_MODEL_TYPE,
  MODEL_PROVIDERS,
  normalizeModelForProvider,
  type ModelProviderOption,
  type ModelType,
} from '@/lib/model-providers'

const DEFAULT_MODEL = {
  provider: 'chatgpt-oauth',
  model: 'chatgpt-oauth-default',
  modelType: DEFAULT_MODEL_TYPE,
  temperature: 0.2,
  maxTokens: 4096,
}

export function CreateAgentForm({
  providers = MODEL_PROVIDERS,
}: {
  providers?: ModelProviderOption[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null)
  const safeProviders = providers.length > 0 ? providers : MODEL_PROVIDERS
  const [provider, setProvider] = useState(safeProviders[0].value)
  const [model, setModel] = useState(safeProviders[0].defaultModel)
  const [modelType, setModelType] = useState<ModelType>(DEFAULT_MODEL_TYPE)
  const selectedProvider = safeProviders.find((p) => p.value === provider) ?? safeProviders[0]

  return (
    <Card title="Új agent">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          const fd = new FormData(e.currentTarget)
          startTransition(async () => {
            setError(null)
            const res = await createAgent({
              name: String(fd.get('name')),
              roleInstruction: String(fd.get('roleInstruction')),
              behaviorProfile: String(fd.get('behaviorProfile')),
              role: (fd.get('role') === 'orchestrator' ? 'orchestrator' : 'worker'),
              modelConfig: {
                ...DEFAULT_MODEL,
                provider,
                model: normalizeModelForProvider(provider, model, safeProviders),
                modelType,
                temperature: Number(fd.get('temperature') ?? DEFAULT_MODEL.temperature),
              },
            })
            if (res.success) {
              setApiKey(res.data.apiKey)
              setCreatedAgentId(res.data.agent.id)
              router.refresh()
            } else {
              setError(res.error)
            }
          })
        }}
      >
        <label className="block text-sm">
          <span className="text-ink-soft">Név</span>
          <input
            name="name"
            required
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
            placeholder="Wiki agent"
          />
        </label>
        <label className="block text-sm">
          <span className="text-ink-soft">Registry szerep</span>
          <select
            name="role"
            defaultValue="worker"
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          >
            <option value="worker">worker</option>
            <option value="orchestrator">orchestrator (tool-less)</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-ink-soft">Szerep-instrukció („mit csinál”)</span>
          <textarea
            name="roleInstruction"
            required
            rows={3}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
            placeholder="Te az Excellence Pay belső tudás-asszisztense vagy. Kizárólag a jóváhagyott belső tudásbázisból válaszolsz."
          />
        </label>
        <label className="block text-sm">
          <span className="text-ink-soft">Viselkedés-profil („hogyan”)</span>
          <textarea
            name="behaviorProfile"
            required
            rows={5}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
            placeholder="Magyarul, tömören válaszolj, minden állításhoz adj forráshivatkozást..."
          />
        </label>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-ink-soft">Modellforrás (provider)</span>
            <select
              name="provider"
              value={provider}
              onChange={(e) => {
                const next = safeProviders.find((p) => p.value === e.target.value) ?? safeProviders[0]
                setProvider(next.value)
                setModel(normalizeModelForProvider(next.value, model, safeProviders))
              }}
              className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
            >
              {safeProviders.map((p) => (
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
              providers={safeProviders}
            />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-ink-soft">Modell típus (gondolkodási profil)</span>
            <ModelTypeSelectField modelType={modelType} onModelTypeChange={setModelType} />
          </label>
        </div>
        <p className="text-xs text-ink-soft">{selectedProvider.hint}</p>
        <label className="block text-sm">
          <span className="text-ink-soft">Temperature</span>
          <input
            name="temperature"
            type="number"
            step="0.1"
            min={0}
            max={2}
            defaultValue={DEFAULT_MODEL.temperature}
            className="mt-1 w-32 rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          />
        </label>
        {error && <p className="text-sm text-coral">{error}</p>}
        {apiKey && (
          <div className="space-y-2 rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
            <p>API kulcs (egyszer látható): {apiKey}</p>
            {createdAgentId && (
              <button
                type="button"
                onClick={() => router.push(`/control-plane/agents/${createdAgentId}`)}
                className="rounded-full bg-sage/30 px-3 py-1 font-semibold"
              >
                Agent megnyitása →
              </button>
            )}
          </div>
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
        >
          {pending ? 'Létrehozás...' : 'Agent létrehozása'}
        </button>
      </form>
    </Card>
  )
}
