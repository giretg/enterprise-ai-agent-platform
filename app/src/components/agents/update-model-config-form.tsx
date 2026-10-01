'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentModelConfig } from '@/app/actions/model-config'
import { Card } from '@/components/ui/shell'
import { MAX_FALLBACK_MODELS, type AgentModelConfig } from '@/lib/agent-model-config'
import { fallbackPreviewLines } from '@/lib/model-fallback-preview'
import { MODEL_TYPES, DEFAULT_MODEL_TYPE, providerUsesThinkingProfile, type ModelType } from '@/lib/model-providers'
import { modelDisplayName, modelRefKey, type ModelPolicy, type ModelRef } from '@/lib/model-policy'

const fromKey = (policy: ModelPolicy, key: string) => policy.enabled.find((r) => modelRefKey(r) === key) ?? null

/** Admin: elsődleges + tartalék modell agentenként — csak a tenant engedett listájából. */
export function UpdateModelConfigForm({
  agentId,
  policy,
  globalChain,
  config,
  effectivePrimary,
  maxAttempts,
  canEdit,
}: {
  agentId: string
  policy: ModelPolicy
  globalChain: ModelRef[]
  config: AgentModelConfig | null
  /** A beállított modell, vagy (ha nincs) az engedett lista első modellje. */
  effectivePrimary: ModelRef | null
  maxAttempts: number
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [primaryKey, setPrimaryKey] = useState(effectivePrimary ? modelRefKey(effectivePrimary) : '')
  const [fallbacks, setFallbacks] = useState<ModelRef[]>(config?.fallbackModels ?? [])
  const [addKey, setAddKey] = useState('')
  const [modelType, setModelType] = useState<ModelType>(config?.modelType ?? DEFAULT_MODEL_TYPE)
  const [temperature, setTemperature] = useState(String(config?.temperature ?? 0.2))
  const [maxTokens, setMaxTokens] = useState(String(config?.maxTokens ?? 4096))

  if (policy.enabled.length === 0) {
    return (
      <Card title="Gondolkodási motor">
        <p className="rounded-lg border border-honey/40 bg-honey/10 px-3 py-2 text-sm text-honey">
          Még nincs engedélyezett modell, ezért az agentek nem tudnak válaszolni. Egy admin a Beállítások →
          Engedett modellek oldalon engedélyezhet néhányat.
        </p>
      </Card>
    )
  }

  const primary = fromKey(policy, primaryKey)
  const candidates = policy.enabled.filter(
    (r) => modelRefKey(r) !== primaryKey && !fallbacks.some((f) => modelRefKey(f) === modelRefKey(r)),
  )
  const preview = fallbackPreviewLines({
    primary,
    agentFallbacks: fallbacks,
    globalFallbacks: globalChain,
    policy,
    maxAttempts,
  })

  function save() {
    if (!primary) return
    setError(null)
    setDone(false)
    startTransition(async () => {
      const temp = Number(temperature)
      const tokens = Number(maxTokens)
      const res = await updateAgentModelConfig({
        agentId,
        modelConfig: {
          ...primary,
          ...(providerUsesThinkingProfile(primary.provider) ? { modelType } : {}),
          ...(Number.isFinite(temp) ? { temperature: temp } : {}),
          ...(Number.isInteger(tokens) && tokens > 0 ? { maxTokens: tokens } : {}),
          fallbackModels: fallbacks,
        },
      })
      if (res.success) {
        setDone(true)
        router.refresh()
      } else {
        setError(res.error)
      }
    })
  }

  return (
    <Card title="Gondolkodási motor">
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">
          Itt dönthetsz arról, melyik AI-modell dolgozik ennek a munkatársnak. A választék a cég engedett
          modelljeiből áll. Ha nem állítasz be semmit, az engedett lista első modellje fut.
        </p>

        <label className="block text-sm">
          <span className="text-ink-soft">Elsődleges modell — ezt használja alapból</span>
          <select
            value={primaryKey}
            disabled={!canEdit || pending}
            onChange={(e) => setPrimaryKey(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          >
            {!primary ? <option value={primaryKey}>{primaryKey || 'Válassz modellt…'}</option> : null}
            {policy.enabled.map((r) => (
              <option key={modelRefKey(r)} value={modelRefKey(r)}>
                {modelDisplayName(r)}
              </option>
            ))}
          </select>
        </label>
        {!primary && primaryKey ? (
          <p className="text-xs text-coral">
            Ez a modell már nincs engedélyezve — válassz másikat, különben a tartalékra esik vissza.
          </p>
        ) : null}

        <div className="rounded-lg border border-line/50 bg-night/30 p-3">
          <p className="text-sm font-medium text-ink">Tartalék modellek</p>
          <p className="mt-1 text-xs text-ink-soft">
            Ha az elsődleges modell szolgáltatója nem elérhető vagy túlterhelt, ezeket próbáljuk sorban.
            A váltás a naplóban látszik. Beszélgetés közben, az első szó után már nem váltunk.
          </p>
          {fallbacks.length === 0 ? (
            <p className="mt-2 text-xs text-ink-faint">Nincs saját tartalék — csak a közös lánc segít kiesésnél.</p>
          ) : (
            <ol className="mt-2 space-y-1">
              {fallbacks.map((f, i) => (
                <li key={modelRefKey(f)} className="flex items-center justify-between text-sm text-ink">
                  <span>
                    {i + 1}. {modelDisplayName(f)}
                  </span>
                  {canEdit ? (
                    <button
                      type="button"
                      className="text-xs text-coral"
                      onClick={() => setFallbacks(fallbacks.filter((_, j) => j !== i))}
                    >
                      Töröl
                    </button>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          {canEdit && fallbacks.length < MAX_FALLBACK_MODELS && candidates.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={addKey}
                onChange={(e) => setAddKey(e.target.value)}
                className="rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
              >
                <option value="">Válassz tartalékot…</option>
                {candidates.map((r) => (
                  <option key={modelRefKey(r)} value={modelRefKey(r)}>
                    {modelDisplayName(r)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!addKey}
                className="rounded-full border border-line px-4 py-1.5 text-xs font-medium text-ink disabled:opacity-40"
                onClick={() => {
                  const ref = fromKey(policy, addKey)
                  if (ref) setFallbacks([...fallbacks, ref])
                  setAddKey('')
                }}
              >
                Hozzáad
              </button>
            </div>
          ) : null}
        </div>

        <div className="rounded-lg border border-line/50 bg-night/30 p-3">
          <p className="text-sm font-medium text-ink">Mi történik kiesés esetén?</p>
          {preview.length === 0 ? (
            <p className="mt-1 text-xs text-ink-faint">
              Nincs tartalék, ami az engedett modellek közül elérhető lenne — kiesésnél hibát kap a felhasználó.
            </p>
          ) : (
            <ul className="mt-1 space-y-1 text-xs text-ink-soft">
              {preview.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>

        <details className="rounded-lg border border-line/50 bg-night/30 p-3">
          <summary className="cursor-pointer text-sm font-medium text-ink">Haladó beállítások</summary>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {primary && providerUsesThinkingProfile(primary.provider) ? (
              <label className="block text-sm sm:col-span-2">
                <span className="text-ink-soft">Gondolkodási mélység</span>
                <select
                  value={modelType}
                  disabled={!canEdit || pending}
                  onChange={(e) => setModelType(e.target.value as ModelType)}
                  className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
                >
                  {MODEL_TYPES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label} — {t.description}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="block text-sm">
              <span className="text-ink-soft">Kreativitás (0 = pontos, 2 = merész)</span>
              <input
                type="number"
                step="0.1"
                min={0}
                max={2}
                value={temperature}
                disabled={!canEdit || pending}
                onChange={(e) => setTemperature(e.target.value)}
                className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="text-ink-soft">Válasz maximális hossza (token)</span>
              <input
                type="number"
                min={1}
                value={maxTokens}
                disabled={!canEdit || pending}
                onChange={(e) => setMaxTokens(e.target.value)}
                className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
              />
            </label>
          </div>
        </details>

        {error ? <p className="text-sm text-coral">{error}</p> : null}
        {done ? (
          <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">Mentve.</p>
        ) : null}
        {canEdit ? (
          <button
            type="button"
            disabled={pending || !primary}
            onClick={save}
            className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
          >
            {pending ? 'Mentés...' : 'Mentés'}
          </button>
        ) : (
          <p className="text-xs text-ink-soft">Módosításhoz admin jogosultság szükséges.</p>
        )}
      </div>
    </Card>
  )
}
