'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { updateAgentProfile } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

/** Az agent neve és bemutatkozó szövege — a név a következő közzétételkor lép életbe az MCP-n. */
export function UpdateAgentProfileForm({
  agentId,
  name,
  description,
  canEdit = true,
  bare = false,
}: {
  agentId: string
  name: string
  description: string | null
  canEdit?: boolean
  /** A hívó már adott keretet (címsor + doboz) — ne rajzoljunk másodikat. */
  bare?: boolean
}) {
  const router = useRouter()
  const t = useTranslations('AgentProfile')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  if (!canEdit) return null

  const form = (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        const fd = new FormData(e.currentTarget)
        const nextName = String(fd.get('name')).trim()
        const nextDescription = String(fd.get('description')).trim()
        if (nextName === name && nextDescription === (description ?? '')) {
          setError(t('noChange'))
          return
        }
        startTransition(async () => {
          setError(null)
          setDone(null)
          const res = await updateAgentProfile({
            agentId,
            name: nextName,
            description: nextDescription,
          })
          if (res.success) {
            setDone(t('saved'))
            router.refresh()
          } else {
            setError(res.error)
          }
        })
      }}
    >
      <label className="block text-sm">
        <span className="text-ink-soft">{t('name')}</span>
        <input
          name="name"
          defaultValue={name}
          required
          maxLength={120}
          className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
        />
      </label>
      <label className="block text-sm">
        <span className="text-ink-soft">{t('description')}</span>
        <textarea
          name="description"
          defaultValue={description ?? ''}
          rows={3}
          maxLength={500}
          placeholder={t('placeholder')}
          className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
        />
      </label>
      {error && <p className="text-sm text-coral">{error}</p>}
      {done && (
        <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
          {done}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
      >
        {pending ? t('saving') : t('save')}
      </button>
    </form>
  )

  if (bare) return form
  return <Card title={t('title')}>{form}</Card>
}
