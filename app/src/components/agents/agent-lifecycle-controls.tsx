'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import {
  activateAgent,
  resumeAgent,
  retireAgent,
  suspendAgent,
} from '@/app/actions/platform'

type Status = 'draft' | 'active' | 'suspended' | 'retired'

const STATUS_LABEL: Record<Status, string> = {
  draft: 'Vázlat',
  active: 'Aktív',
  suspended: 'Felfüggesztve',
  retired: 'Nyugdíjazva',
}

export function AgentLifecycleControls({
  agentId,
  status,
  suspendedReason,
  canManage = true,
}: {
  agentId: string
  status: Status
  suspendedReason?: string | null
  /** Operátor csak az állapotot látja; az admin ugyanitt kapcsol. */
  canManage?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [askingReason, setAskingReason] = useState(false)

  function run(fn: () => Promise<{ success: boolean; error?: string }>) {
    startTransition(async () => {
      setError(null)
      const res = await fn()
      if (res.success) {
        setAskingReason(false)
        setReason('')
        router.refresh()
      } else {
        setError(res.error ?? 'Ismeretlen hiba')
      }
    })
  }

  const btn =
    'rounded-full px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50'

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-soft">
        Jelenlegi állapot: <span className="font-semibold text-ink">{STATUS_LABEL[status]}</span>
        {status === 'suspended' && suspendedReason && (
          <span className="text-ink-faint"> — {suspendedReason}</span>
        )}
      </p>

      {error && <p className="text-xs text-coral">{error}</p>}

      {!canManage ? null : (
      <div className="flex flex-wrap gap-2">
        {status === 'draft' && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => activateAgent({ agentId }))}
            className={`${btn} bg-sage/20 text-sage hover:bg-sage/30`}
          >
            {pending ? 'Aktiválás…' : 'Aktiválás (verzió befagyasztása)'}
          </button>
        )}

        {status === 'active' && (
          <>
            {!askingReason ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setError(null)
                  setAskingReason(true)
                }}
                className={`${btn} border border-amber-400/40 text-amber-600 hover:bg-amber-500/10`}
              >
                Felfüggesztés
              </button>
            ) : (
              <div className="flex w-full flex-col gap-2 rounded-xl border border-amber-400/30 bg-amber-500/5 p-3">
                <label className="text-xs font-medium text-ink-soft" htmlFor="suspend-reason">
                  Felfüggesztés indoka (kötelező)
                </label>
                <input
                  id="suspend-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="rounded-lg border border-line bg-card px-3 py-1.5 text-sm"
                  placeholder="pl. túl magas hibaarány"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={pending || reason.trim().length === 0}
                    onClick={() => run(() => suspendAgent({ agentId, reason: reason.trim() }))}
                    className={`${btn} bg-amber-500 text-card`}
                  >
                    {pending ? 'Felfüggesztés…' : 'Megerősítés'}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setAskingReason(false)
                      setReason('')
                    }}
                    className={`${btn} border border-line text-ink-soft`}
                  >
                    Mégse
                  </button>
                </div>
              </div>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => retireAgent({ agentId }))}
              className={`${btn} border border-coral/30 text-coral hover:bg-coral/10`}
            >
              Nyugdíjazás
            </button>
          </>
        )}

        {status === 'suspended' && (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => resumeAgent({ agentId }))}
              className={`${btn} bg-sage/20 text-sage hover:bg-sage/30`}
            >
              {pending ? 'Visszaállítás…' : 'Visszaállítás (aktív)'}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => retireAgent({ agentId }))}
              className={`${btn} border border-coral/30 text-coral hover:bg-coral/10`}
            >
              Nyugdíjazás
            </button>
          </>
        )}

        {status === 'retired' && (
          <p className="text-sm italic text-ink-faint">
            Nyugdíjazott munkatárs — terminális állapot. A verziólánc és a múltbeli munkák
            visszakereshetők maradnak.
          </p>
        )}
      </div>
      )}
    </div>
  )
}
