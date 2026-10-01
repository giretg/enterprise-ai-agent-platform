'use client'

import { useMemo, useState, useTransition } from 'react'
import { setTenantModelEnabled } from '@/app/actions/model-config'
import { Card } from '@/components/ui/shell'
import { MODEL_PROVIDERS } from '@/lib/model-providers'
import { modelCatalog, type ModelPolicy, type ModelRef } from '@/lib/model-policy'

/** Tenant admin: mely modelleket használhatják az agentek (költség, adatvédelem). */
export function ModelPolicyPanel({ initial, canEdit }: { initial: ModelPolicy; canEdit: boolean }) {
  const [policy, setPolicy] = useState(initial)
  const [provider, setProvider] = useState<ModelRef['provider']>(MODEL_PROVIDERS[0]!.value as ModelRef['provider'])
  const [custom, setCustom] = useState('')
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const catalog = useMemo(() => modelCatalog(policy), [policy])

  function set(ref: ModelRef, enabled: boolean, okText: string) {
    setMessage(null)
    startTransition(async () => {
      const res = await setTenantModelEnabled({ ...ref, enabled })
      if (res.success) {
        setPolicy(res.data)
        setMessage({ tone: 'ok', text: okText })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <Card title="Engedett modellek">
      <div className="space-y-5">
        <p className="text-sm text-ink-soft">
          Itt döntöd el, melyik AI-modelleket használhatják a munkatársak. Csak a bepipált modellek
          választhatók ki egy munkatárs beállításainál, és csak ezekre válthat a rendszer, ha egy
          szolgáltató kiesik.
        </p>
        {policy.enabled.length === 0 ? (
          <p className="rounded-lg border border-honey/40 bg-honey/10 px-3 py-2 text-sm text-honey">
            Még nincs engedélyezett modell, ezért az agentek nem tudnak válaszolni. Pipálj be legalább egyet.
          </p>
        ) : null}
        <div className="grid gap-4 lg:grid-cols-2">
          {MODEL_PROVIDERS.map((option) => (
            <div key={option.value} className="rounded-lg border border-line/70 bg-panel/40 p-4">
              <p className="text-sm font-semibold text-ink">{option.label}</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-faint">{option.hint}</p>
              <div className="mt-3 space-y-2">
                {catalog
                  .filter((entry) => entry.provider === option.value)
                  .map((entry) => (
                    <label
                      key={`${entry.provider}/${entry.model}`}
                      className="flex items-start gap-3 rounded-md border border-line/50 bg-night/40 p-3 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={entry.enabled}
                        disabled={!canEdit || pending}
                        onChange={(e) =>
                          set(entry, e.target.checked, e.target.checked ? 'Modell engedélyezve.' : 'Modell letiltva.')
                        }
                        className="mt-1 h-4 w-4 accent-coral"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium text-ink">{entry.label}</span>
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

        {canEdit ? (
          <div className="rounded-lg border border-line/70 bg-night/40 p-4">
            <p className="text-sm font-semibold text-ink">Másik modell hozzáadása</p>
            <p className="mt-1 text-xs text-ink-soft">
              Ha a fenti listában nincs ott, add meg a szolgáltató szerinti pontos modellnevet (pl.
              anthropic/claude-sonnet-4 az OpenRouteren).
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-[220px_1fr_auto]">
              <select
                value={provider}
                disabled={pending}
                onChange={(e) => setProvider(e.target.value as ModelRef['provider'])}
                className="rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink"
              >
                {MODEL_PROVIDERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <input
                value={custom}
                disabled={pending}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="Modellnév"
                className="rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink"
              />
              <button
                type="button"
                disabled={pending || !custom.trim()}
                onClick={() => {
                  set({ provider, model: custom.trim() }, true, 'Modell engedélyezve.')
                  setCustom('')
                }}
                className="rounded-lg bg-coral/20 px-4 py-2 text-sm font-semibold text-coral disabled:opacity-40"
              >
                Engedélyezés
              </button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-ink-soft">Módosításhoz admin jogosultság szükséges.</p>
        )}

        {message ? (
          <p className={`text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}>{message.text}</p>
        ) : null}
      </div>
    </Card>
  )
}
