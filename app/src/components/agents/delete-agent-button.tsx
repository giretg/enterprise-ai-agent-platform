'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { deleteAgent } from '@/app/actions/platform'

export function DeleteAgentButton({
  agentId,
  agentName,
  compact = false,
}: {
  agentId: string
  agentName: string
  compact?: boolean
}) {
  const t = useTranslations('AgentUi')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setError(null)
          setConfirming(true)
        }}
        className={
          compact
            ? 'rounded-full border border-coral/30 px-3 py-1 text-xs font-semibold text-coral transition-colors hover:bg-coral/10'
            : 'rounded-full border border-coral/30 px-4 py-2 text-sm font-semibold text-coral transition-colors hover:bg-coral/10'
        }
      >
        {t('delete')}
      </button>
    )
  }

  return (
    <div
      className="rounded-xl border border-coral/30 bg-coral/5 p-3 text-left"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <p className="text-xs leading-relaxed text-ink-soft">
        {t('confirmDelete', { name: agentName })}
      </p>
      {error && <p className="mt-2 text-xs text-coral">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            startTransition(async () => {
              setError(null)
              const res = await deleteAgent({ id: agentId })
              if (res.success) {
                setConfirming(false)
                router.push('/control-plane/agents')
                router.refresh()
              } else {
                setError(res.error)
              }
            })
          }}
          className="rounded-full bg-coral px-3 py-1 text-xs font-semibold text-card disabled:opacity-50"
        >
          {pending ? t('deleting') : t('confirmYes')}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setConfirming(false)
            setError(null)
          }}
          className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft disabled:opacity-50"
        >
          {t('cancel')}
        </button>
      </div>
    </div>
  )
}
