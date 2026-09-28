'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { updateAgentLocalRoots } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

/** Helyi git-mappák — hint a desktop harnessnek, nem jogosultság. */
export function UpdateLocalRootsForm({
  agentId,
  localRoots,
  canEdit = true,
  bare = false,
}: {
  agentId: string
  localRoots: string
  canEdit?: boolean
  bare?: boolean
}) {
  const router = useRouter()
  const t = useTranslations('AgentLocalRoots')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const form = (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        const next = String(new FormData(e.currentTarget).get('localRoots') ?? '')
        if (next.trim() === localRoots.trim()) {
          setError(t('noChange'))
          return
        }
        startTransition(async () => {
          setError(null)
          setDone(null)
          const res = await updateAgentLocalRoots({ agentId, localRoots: next })
          if (res.success) {
            setDone(t('saved'))
            router.refresh()
          } else {
            setError(res.error)
          }
        })
      }}
    >
      <p className="text-sm text-ink-soft">{t('help')}</p>
      {canEdit ? (
        <label className="block text-sm">
          <span className="text-ink-soft">{t('label')}</span>
          <textarea
            name="localRoots"
            defaultValue={localRoots}
            rows={3}
            maxLength={4200}
            placeholder={t('placeholder')}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 font-mono text-sm"
          />
        </label>
      ) : (
        <p className="text-sm text-ink">
          {localRoots.trim() ? localRoots : t('empty')}
        </p>
      )}
      {error && <p className="text-sm text-coral">{error}</p>}
      {done && (
        <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
          {done}
        </p>
      )}
      {canEdit ? (
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
        >
          {pending ? t('saving') : t('save')}
        </button>
      ) : null}
    </form>
  )

  if (bare) return form
  return <Card title={t('title')}>{form}</Card>
}
