'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentModelConfig } from '@/app/actions/platform'
import { ModelSelectField } from '@/components/agents/model-select-field'
import { Card } from '@/components/ui/shell'
import { MODEL_PROVIDERS, normalizeModelForProvider, providerOption } from '@/lib/model-providers'

// Admin agentenként módosíthatja a modell-konfigot (provider/model/temperature/
// maxTokens). Minden mentés új agent-verziót fagyaszt be (reprodukálhatóság).
export function UpdateModelConfigForm({
  agentId,
  current,
}: {
  agentId: string
  current: { provider: string; model: string; temperature?: number; maxTokens?: number }
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [provider, setProvider] = useState(current.provider)
  const [model, setModel] = useState(current.model)

  const selected = providerOption(provider)
  const unchanged =
    provider === current.provider && model.trim() === current.model

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
                model: normalizeModelForProvider(provider, model),
                ...(Number.isFinite(temperature) ? { temperature } : {}),
                ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
              },
            })
            if (res.success) {
              setDone(`Agent v${res.data.agentVersion} — ${provider}/${model.trim() || selected.defaultModel}`)
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
                const next = providerOption(e.target.value)
                setProvider(next.value)
                setModel(normalizeModelForProvider(next.value, model))
              }}
              className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
            >
              {MODEL_PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Modell</span>
            <ModelSelectField provider={provider} model={model} onModelChange={setModel} />
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
