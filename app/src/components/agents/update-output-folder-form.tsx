'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentOutputFolder } from '@/app/actions/platform'

/** Agent saját Drive output-mappája: ide az agent jóváhagyás nélkül, auditáltan tölt fel. */
export function UpdateOutputFolderForm({
  agentId,
  outputDriveFolderId,
  canEdit = true,
}: {
  agentId: string
  outputDriveFolderId: string | null
  canEdit?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  if (!canEdit) {
    return (
      <p className="text-sm text-ink-soft">
        {outputDriveFolderId
          ? `Output-mappa: ${outputDriveFolderId} — ide az agent jóváhagyás nélkül tölt fel.`
          : 'Nincs output-mappa — minden Drive-feltöltés jóváhagyást kér.'}
      </p>
    )
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        const fd = new FormData(e.currentTarget)
        const next = String(fd.get('folderId') ?? '').trim()
        if ((next || null) === outputDriveFolderId) {
          setError('Nincs változás')
          return
        }
        startTransition(async () => {
          setError(null)
          setDone(null)
          const res = await updateAgentOutputFolder({ agentId, folderId: next })
          if (res.success) {
            setDone(
              next
                ? 'Mentve. Ebbe a mappába az agent jóváhagyás nélkül tölt fel.'
                : 'Törölve. Mostantól minden Drive-feltöltés jóváhagyást kér.',
            )
            router.refresh()
          } else {
            setError(res.error)
          }
        })
      }}
    >
      <div className="space-y-2">
        <label htmlFor="output-folder-id" className="text-sm text-ink-soft">
          Drive mappa-id (az URL-ben az <code>folders/…</code> rész). Üresen hagyva törlöd.
        </label>
        <input
          id="output-folder-id"
          name="folderId"
          defaultValue={outputDriveFolderId ?? ''}
          placeholder="pl. 1AbC2dEfGhIjKlMnOpQrStUvWx"
          maxLength={200}
          className="w-full rounded-lg border border-ink/15 bg-white/80 px-3 py-2 text-sm"
        />
      </div>
      {error && <p className="text-sm text-coral">{error}</p>}
      {done && (
        <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">{done}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
      >
        {pending ? 'Mentés...' : 'Mentés'}
      </button>
    </form>
  )
}
