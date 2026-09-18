'use client'

import { useMemo, useState, useTransition } from 'react'
import { adminUpsertModelPolicyEntry } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'
import { MODEL_PROVIDERS } from '@/lib/model-providers'
import type { ModelPolicy, ModelPolicyEntry } from '@/lib/model-policy'

function byProvider(entries: ModelPolicyEntry[], provider: string): ModelPolicyEntry[] {
  return entries.filter((entry) => entry.provider === provider)
}

export function ModelPolicyPanel({
  initial,
  canEdit,
}: {
  initial: ModelPolicy
  canEdit: boolean
}) {
  const [policy, setPolicy] = useState(initial)
  const [provider, setProvider] = useState('openrouter')
  const [model, setModel] = useState('')
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const providerGroups = useMemo(
    () =>
      MODEL_PROVIDERS.map((option) => ({
        option,
        entries: byProvider(policy.entries, option.value),
      })),
    [policy.entries],
  )

  function toggle(entry: ModelPolicyEntry, enabled: boolean) {
    setMessage(null)
    startTransition(async () => {
      const res = await adminUpsertModelPolicyEntry({
        provider: entry.provider,
        model: entry.model,
        enabled,
        label: entry.label,
        description: entry.description,
      })
      if (res.success) {
        setPolicy(res.data)
        setMessage({ tone: 'ok', text: 'Mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  function addCustomModel() {
    const trimmed = model.trim()
    if (!trimmed) return
    setMessage(null)
    startTransition(async () => {
      const res = await adminUpsertModelPolicyEntry({
        provider,
        model: trimmed,
        enabled: true,
        label: trimmed,
      })
      if (res.success) {
        setPolicy(res.data)
        setModel('')
        setMessage({ tone: 'ok', text: 'Modell engedélyezve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <Card title="Modell engedélyezés">
      <div className="space-y-5">
        <div className="grid gap-4 lg:grid-cols-2">
          {providerGroups.map(({ option, entries }) => (
            <div key={option.value} className="rounded-lg border border-line/70 bg-panel/40 p-4">
              <div className="mb-3">
                <p className="text-sm font-semibold text-ink">{option.label}</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-faint">{option.hint}</p>
              </div>
              <div className="space-y-2">
                {entries.map((entry) => (
                  <label
                    key={`${entry.provider}:${entry.model}`}
                    className="flex items-start gap-3 rounded-md border border-line/50 bg-night/40 p-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={entry.enabled}
                      disabled={!canEdit || pending}
                      onChange={(event) => toggle(entry, event.target.checked)}
                      className="mt-1 h-4 w-4 accent-coral"
                    />
                    <span className="min-w-0">
                      <span className="block font-medium text-ink">{entry.label || entry.model}</span>
                      <span className="block break-all text-xs text-ink-faint">{entry.model}</span>
                      {entry.description ? (
                        <span className="mt-1 block text-xs text-ink-soft">{entry.description}</span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-line/70 bg-night/40 p-4">
          <p className="text-sm font-semibold text-ink">Egyedi modell slug</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-[220px_1fr_auto]">
            <select
              value={provider}
              disabled={!canEdit || pending}
              onChange={(event) => setProvider(event.target.value)}
              className="rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink disabled:opacity-50"
            >
              {MODEL_PROVIDERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <input
              value={model}
              disabled={!canEdit || pending}
              onChange={(event) => setModel(event.target.value)}
              placeholder="pl. anthropic/claude-sonnet-4"
              className="rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink disabled:opacity-50"
            />
            <button
              type="button"
              disabled={!canEdit || pending || !model.trim()}
              onClick={addCustomModel}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Engedélyezés
            </button>
          </div>
        </div>

        {message ? (
          <p
            className={`rounded-lg border px-3 py-2 text-sm ${
              message.tone === 'ok'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/30 bg-red-500/10 text-red-300'
            }`}
          >
            {message.text}
          </p>
        ) : null}

        {!canEdit ? (
          <p className="text-xs text-ink-soft">Módosításhoz admin jogosultság szükséges.</p>
        ) : null}
      </div>
    </Card>
  )
}
