'use client'

import { useState, useTransition } from 'react'
import { setGlobalFallbackChain } from '@/app/actions/model-config'
import { Card } from '@/components/ui/shell'
import { modelCatalog, modelDisplayName, modelRefKey, EMPTY_MODEL_POLICY, type ModelRef } from '@/lib/model-policy'

const OPTIONS = modelCatalog(EMPTY_MODEL_POLICY)

/** Platform: a közös tartalék-lánc, ami minden agent saját tartaléka UTÁN jön. */
export function FallbackChainPanel({ initial, canEdit }: { initial: ModelRef[]; canEdit: boolean }) {
  const [saved, setSaved] = useState(initial)
  const [chain, setChain] = useState(initial)
  const [pick, setPick] = useState('')
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const dirty = JSON.stringify(chain) !== JSON.stringify(saved)

  function add() {
    const found = OPTIONS.find((o) => modelRefKey(o) === pick)
    if (!found || chain.some((c) => modelRefKey(c) === pick)) return
    setChain([...chain, { provider: found.provider, model: found.model }])
    setPick('')
  }

  function save() {
    setMessage(null)
    startTransition(async () => {
      const res = await setGlobalFallbackChain(chain)
      if (res.success) {
        setSaved(res.data)
        setChain(res.data)
        setMessage({ tone: 'ok', text: 'Tartalék-lánc mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <Card title="Közös tartalék-lánc">
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">
          Ha egy szolgáltató kiesik, a rendszer először az agent saját tartalék modelljeit próbálja, utána
          ezt a közös listát — de csak azokat, amiket az adott cég engedélyezett. A váltás a naplóban
          látszik.
        </p>
        {chain.length === 0 ? (
          <p className="text-sm text-honey">Még nincs közös tartalék. Csak az agentek saját tartalékai működnek.</p>
        ) : (
          <ol className="list-inside list-decimal space-y-1 text-sm text-ink">
            {chain.map((ref, i) => (
              <li key={modelRefKey(ref)}>
                {modelDisplayName(ref)}
                {canEdit ? (
                  <button
                    type="button"
                    className="ml-3 text-xs text-coral"
                    onClick={() => setChain(chain.filter((_, j) => j !== i))}
                  >
                    Töröl
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              className="rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
            >
              <option value="">Válassz modellt…</option>
              {OPTIONS.filter((o) => !chain.some((c) => modelRefKey(c) === modelRefKey(o))).map((o) => (
                <option key={modelRefKey(o)} value={modelRefKey(o)}>
                  {modelDisplayName(o)}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!pick}
              onClick={add}
              className="rounded-full border border-line px-4 py-1.5 text-xs font-medium text-ink disabled:opacity-40"
            >
              Hozzáad
            </button>
            <button
              type="button"
              disabled={pending || !dirty}
              onClick={save}
              className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
            >
              {pending ? 'Mentés...' : 'Mentés'}
            </button>
          </div>
        ) : (
          <p className="text-xs text-ink-soft">Módosításhoz szuperadmin jogosultság szükséges.</p>
        )}
        {message ? (
          <p className={`text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}>{message.text}</p>
        ) : null}
      </div>
    </Card>
  )
}
