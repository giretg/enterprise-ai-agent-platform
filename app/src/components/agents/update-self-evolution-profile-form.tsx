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
}

export function UpdateSelfEvolutionProfileForm({
  agentId,
  currentProfile,
}: {
  agentId: string
  currentProfile: unknown
}) {
  const router = useRouter()
  const resolved = resolveSelfEvolutionProfile(currentProfile)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile>(resolved)

  const toggleScope = (scope: Profile['scope'][number]) => {
    setProfile((prev) => {
      const has = prev.scope.includes(scope)
      const nextScope = has ? prev.scope.filter((s) => s !== scope) : [...prev.scope, scope]
      return { ...prev, scope: nextScope.length ? nextScope : [scope] }
    })
  }

  return (
    <Card title="Önfejlesztés szabályainak szerkesztése">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          startTransition(async () => {
            setError(null)
            const res = await updateAgentSelfEvolutionProfile({ agentId, profile })
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
          <span className="text-ink-soft">Jóváhagyás</span>
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
    </Card>
  )
}
