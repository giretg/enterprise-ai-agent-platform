'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentSelfEvolutionProfile } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'
import { resolveSelfEvolutionProfile } from '@/lib/self-evolution-profile'

type Profile = {
  scope: Array<'memory' | 'behavior' | 'role'>
  approval_mode: 'human' | 'higher_role' | 'eval_only' | 'auto_after_eval'
  diff_limit?: number
  durable_memory_approval_policy: {
    activation_mode: 'approver_required' | 'operator_can_activate'
    four_eyes_required: boolean
  }
}

export function UpdateSelfEvolutionProfileForm({
  agentId,
  currentProfile,
  bare = false,
}: {
  agentId: string
  currentProfile: unknown
  /** A hívó már adott keretet (címsor + doboz) — ne rajzoljunk másodikat. */
  bare?: boolean
}) {
  const router = useRouter()
  const resolved = resolveSelfEvolutionProfile(currentProfile)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile>({
    scope: resolved.scope,
    approval_mode: resolved.approval_mode,
    diff_limit: resolved.diff_limit,
    durable_memory_approval_policy: {
      activation_mode: resolved.durable_memory_approval_policy?.activation_mode ?? 'approver_required',
      four_eyes_required: false,
    },
  })

  const toggleScope = (scope: Profile['scope'][number]) => {
    setProfile((prev) => {
      const has = prev.scope.includes(scope)
      const nextScope = has ? prev.scope.filter((s) => s !== scope) : [...prev.scope, scope]
      return { ...prev, scope: nextScope.length ? nextScope : [scope] }
    })
  }

  const setDurable = (patch: Partial<Profile['durable_memory_approval_policy']>) => {
    setProfile((prev) => ({
      ...prev,
      durable_memory_approval_policy: {
        ...prev.durable_memory_approval_policy,
        ...patch,
        four_eyes_required: false,
      },
    }))
  }

  const form = (
    <>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          startTransition(async () => {
            setError(null)
            const res = await updateAgentSelfEvolutionProfile({
              agentId,
              profile: {
                ...profile,
                durable_memory_approval_policy: {
                  ...profile.durable_memory_approval_policy,
                  four_eyes_required: false,
                },
              },
            })
            if (res.success) router.refresh()
            else setError(res.error)
          })
        }}
      >
        <fieldset className="space-y-2">
          <legend className="text-sm text-ink-soft">Mit fejleszthet önállóan?</legend>
          {(
            [
              ['memory', 'emlékek'],
              ['behavior', 'munkastílus'],
              ['role', 'munkakör'],
            ] as const
          ).map(([scope, label]) => (
            <label key={scope} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={profile.scope.includes(scope)}
                onChange={() => toggleScope(scope)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <label className="block text-sm">
          <span className="text-ink-soft">Önfejlesztési jóváhagyás</span>
          <select
            value={profile.approval_mode}
            onChange={(e) =>
              setProfile((prev) => ({
                ...prev,
                approval_mode: e.target.value as Profile['approval_mode'],
              }))
            }
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          >
            <option value="human">Minden változást ember hagy jóvá</option>
            <option value="higher_role">Magasabb rangú kolléga hagyja jóvá</option>
            <option value="eval_only">Csak sikeres ellenőrzés után léphet életbe</option>
            <option value="auto_after_eval">Ellenőrzés után automatikusan életbe lép</option>
          </select>
        </label>
        <fieldset className="space-y-2">
          <legend className="text-sm text-ink-soft">Tanítás és projektmemória életbelépése</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="activation_mode"
              checked={profile.durable_memory_approval_policy.activation_mode === 'approver_required'}
              onChange={() => setDurable({ activation_mode: 'approver_required' })}
            />
            Jóváhagyó léptetheti életbe
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="activation_mode"
              checked={profile.durable_memory_approval_policy.activation_mode === 'operator_can_activate'}
              onChange={() => setDurable({ activation_mode: 'operator_can_activate' })}
            />
            Operátor is életbe léptetheti
          </label>
        </fieldset>
        <label className="block text-sm">
          <span className="text-ink-soft">Max. változás méret (opcionális, sorokban)</span>
          <input
            type="number"
            min={1}
            value={profile.diff_limit ?? ''}
            onChange={(e) =>
              setProfile((prev) => ({
                ...prev,
                diff_limit: e.target.value ? Number(e.target.value) : undefined,
              }))
            }
            className="mt-1 w-32 rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          />
        </label>
        {error && <p className="text-sm text-coral">{error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
        >
          {pending ? 'Mentés...' : 'Profil mentése'}
        </button>
      </form>
    </>
  )

  if (bare) return form
  return <Card title="Önfejlesztés szabályainak szerkesztése">{form}</Card>
}
