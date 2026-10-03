'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { updateAgentModelConfig } from '@/app/actions/model-config'
import { OrderedModelList } from '@/components/agents/ordered-model-list'
import { Card } from '@/components/ui/shell'
import { asTranslate } from '@/i18n/translate'
import { MAX_FALLBACK_MODELS, type AgentModelConfig } from '@/lib/agent-model-config'
import { fallbackPreviewSteps } from '@/lib/model-fallback-preview'
import { MODEL_TYPES, DEFAULT_MODEL_TYPE, providerUsesThinkingProfile, type ModelType } from '@/lib/model-providers'
import { modelDisplayName, modelRefKey, type ModelPolicy, type ModelRef } from '@/lib/model-policy'

function modelRefFromPolicy(policy: ModelPolicy, key: string): ModelRef | null {
  return policy.enabled.find((r) => modelRefKey(r) === key) ?? null
}

const THINKING_COPY: Record<ModelType, 'thinkingLuna' | 'thinkingTerra' | 'thinkingSol'> = {
  luna: 'thinkingLuna',
  terra: 'thinkingTerra',
  sol: 'thinkingSol',
}

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
  /** A beállított modell, vagy (ha nincs / tiltott) az engedett lista első modellje. */
  effectivePrimary: ModelRef | null
  maxAttempts: number
  canEdit: boolean
}) {
  const router = useRouter()
  const t = asTranslate(useTranslations('AgentModelConfig'))
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
      <Card title={t('title')}>
        <p className="rounded-lg border border-honey/40 bg-honey/10 px-3 py-2 text-sm text-honey">{t('emptyPolicy')}</p>
      </Card>
    )
  }

  const primary = modelRefFromPolicy(policy, primaryKey)
  const candidates = policy.enabled.filter(
    (r) => modelRefKey(r) !== primaryKey && !fallbacks.some((f) => modelRefKey(f) === modelRefKey(r)),
  )
  const preview = fallbackPreviewSteps({
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
        setError(
          ['not_found', 'not_allowed', 'load_failed', 'save_failed'].includes(res.error)
            ? t(`errors.${res.error}`)
            : res.error,
        )
      }
    })
  }

  return (
    <Card title={t('title')}>
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">{t('help')}</p>

        <label className="block text-sm">
          <span className="text-ink-soft">{t('primary')}</span>
          <select
            value={primaryKey}
            disabled={!canEdit || pending}
            onChange={(e) => setPrimaryKey(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          >
            {!primary ? <option value={primaryKey}>{primaryKey || t('pickModel')}</option> : null}
            {policy.enabled.map((r) => (
              <option key={modelRefKey(r)} value={modelRefKey(r)}>
                {modelDisplayName(r)}
              </option>
            ))}
          </select>
        </label>
        {!primary && primaryKey ? <p className="text-xs text-coral">{t('primaryDisabled')}</p> : null}

        <div className="rounded-lg border border-line/50 bg-night/30 p-3">
          <p className="text-sm font-medium text-ink">{t('fallbacksTitle')}</p>
          <p className="mt-1 text-xs text-ink-soft">{t('fallbacksHelp')}</p>
          {fallbacks.length === 0 ? (
            <p className="mt-2 text-xs text-ink-faint">{t('noOwnFallback')}</p>
          ) : (
            <div className="mt-2">
              <OrderedModelList
                items={fallbacks}
                canEdit={canEdit}
                onRemove={(i) => setFallbacks(fallbacks.filter((_, j) => j !== i))}
                removeLabel={t('remove')}
              />
            </div>
          )}
          {canEdit && fallbacks.length < MAX_FALLBACK_MODELS && candidates.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={addKey}
                onChange={(e) => setAddKey(e.target.value)}
                className="rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
              >
                <option value="">{t('pickFallback')}</option>
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
                  const ref = modelRefFromPolicy(policy, addKey)
                  if (ref) setFallbacks([...fallbacks, ref])
                  setAddKey('')
                }}
              >
                {t('add')}
              </button>
            </div>
          ) : null}
        </div>

        <div className="rounded-lg border border-line/50 bg-night/30 p-3">
          <p className="text-sm font-medium text-ink">{t('previewTitle')}</p>
          {preview.length === 0 ? (
            <p className="mt-1 text-xs text-ink-faint">{t('previewEmpty')}</p>
          ) : (
            <ul className="mt-1 space-y-1 text-xs text-ink-soft">
              {preview.map((step) => (
                <li key={`${modelRefKey(step.from)}>${modelRefKey(step.to)}`}>
                  {t('previewLine', {
                    from: modelDisplayName(step.from),
                    to: modelDisplayName(step.to),
                  })}
                </li>
              ))}
            </ul>
          )}
        </div>

        <details className="rounded-lg border border-line/50 bg-night/30 p-3">
          <summary className="cursor-pointer text-sm font-medium text-ink">{t('advanced')}</summary>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {primary && providerUsesThinkingProfile(primary.provider) ? (
              <label className="block text-sm sm:col-span-2">
                <span className="text-ink-soft">{t('thinking')}</span>
                <select
                  value={modelType}
                  disabled={!canEdit || pending}
                  onChange={(e) => setModelType(e.target.value as ModelType)}
                  className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
                >
                  {MODEL_TYPES.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label} — {t(THINKING_COPY[option.id])}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="block text-sm">
              <span className="text-ink-soft">{t('temperature')}</span>
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
              <span className="text-ink-soft">{t('maxTokens')}</span>
              <input
                type="number"
                min={1}
                value={maxTokens}
                disabled={!canEdit || pending}
                onChange={(e) => setMaxTokens(e.target.value)}
                className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
              />
              <span className="mt-1 block text-xs text-ink-faint">{t('maxTokensHelp')}</span>
            </label>
          </div>
        </details>

        {error ? <p className="text-sm text-coral">{error}</p> : null}
        {done ? (
          <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">{t('saved')}</p>
        ) : null}
        {canEdit ? (
          <button
            type="button"
            disabled={pending || !primary}
            onClick={save}
            className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
          >
            {pending ? t('saving') : t('save')}
          </button>
        ) : (
          <p className="text-xs text-ink-soft">{t('needAdmin')}</p>
        )}
      </div>
    </Card>
  )
}
