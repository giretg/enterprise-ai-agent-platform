'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import { updateAgentOutputFolder } from '@/app/actions/platform'
import { GoogleDriveFolderPickerButton } from '@/components/account/google-drive-folder-picker-button'

/** Agent saját Drive output-mappája: ide az agent jóváhagyás nélkül, auditáltan tölt fel. */
export function UpdateOutputFolderForm({
  agentId,
  outputDriveFolderId,
  driveGrantId,
  drivePickerConfigured,
  canEdit = true,
}: {
  agentId: string
  outputDriveFolderId: string | null
  driveGrantId: string | null
  drivePickerConfigured: boolean
  canEdit?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [folderId, setFolderId] = useState(outputDriveFolderId ?? '')
  const [folderLabel, setFolderLabel] = useState<string | null>(
    outputDriveFolderId ? outputDriveFolderId : null,
  )

  useEffect(() => {
    setFolderId(outputDriveFolderId ?? '')
    setFolderLabel(outputDriveFolderId ?? null)
  }, [outputDriveFolderId])

  if (!canEdit) {
    return (
      <p className="text-sm text-ink-soft">
        {outputDriveFolderId
          ? `Output-mappa: ${outputDriveFolderId} — ide az agent jóváhagyás nélkül tölt fel.`
          : 'Nincs output-mappa — minden Drive-feltöltés jóváhagyást kér.'}
      </p>
    )
  }

  const saveFolder = (nextId: string) => {
    startTransition(async () => {
      setError(null)
      setDone(null)
      const res = await updateAgentOutputFolder({ agentId, folderId: nextId })
      if (res.success) {
        setDone(
          nextId
            ? 'Mentve. Ebbe a mappába az agent jóváhagyás nélkül tölt fel.'
            : 'Törölve. Mostantól minden Drive-feltöltés jóváhagyást kér.',
        )
        router.refresh()
      } else {
        setError(res.error)
      }
    })
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-soft">
        Válassz egy Drive-mappát, ahová az agent jóváhagyás nélkül is feltölthet. Ha üresen marad,
        minden feltöltés jóváhagyást kér.
      </p>

      {folderId ? (
        <p className="text-sm text-ink">
          Kiválasztott mappa:{' '}
          <span className="font-medium">{folderLabel && folderLabel !== folderId ? folderLabel : 'Drive-mappa'}</span>
          <span className="ml-2 font-mono text-xs text-ink-faint">{folderId}</span>
        </p>
      ) : (
        <p className="text-sm italic text-ink-faint">Még nincs output-mappa beállítva.</p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <GoogleDriveFolderPickerButton
          grantId={driveGrantId}
          pickerConfigured={drivePickerConfigured}
          disabled={pending}
          onPicked={(folder) => {
            setFolderId(folder.id)
            setFolderLabel(folder.name)
            saveFolder(folder.id)
          }}
          onError={(message) => setError(message)}
        />
        {folderId ? (
          <button
            type="button"
            disabled={pending}
            className="rounded-full px-3 py-1.5 text-xs font-semibold text-ink-soft hover:bg-ink/5 disabled:opacity-50"
            onClick={() => {
              setFolderId('')
              setFolderLabel(null)
              saveFolder('')
            }}
          >
            Mappa törlése
          </button>
        ) : null}
      </div>

      {!driveGrantId ? (
        <p className="text-xs text-honey">
          A böngészéshez kösd be a Google Drive-ot a{' '}
          <Link href="/control-plane/account" className="font-semibold text-coral-deep underline">
            Kapcsolt fiókok
          </Link>{' '}
          oldalon (olvasás + írás kijelölt fájlokon profil).
        </p>
      ) : null}

      {error && <p className="text-sm text-coral">{error}</p>}
      {done && (
        <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">{done}</p>
      )}
    </div>
  )
}
