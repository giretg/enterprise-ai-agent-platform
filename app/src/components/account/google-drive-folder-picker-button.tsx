'use client'

import { useCallback, useTransition } from 'react'
import { getGoogleDrivePickerSession } from '@/app/actions/connector-grants'
import {
  ensureGooglePickerLoaded,
  openGoogleDriveFolderPicker,
} from '@/lib/google-drive-picker-client'

/** Egy Drive-mappa kiválasztása (agent output-mappa stb.) — nem ment grant-metadatába. */
export function GoogleDriveFolderPickerButton({
  grantId,
  pickerConfigured,
  disabled,
  label = 'Mappa kiválasztása a Drive-on',
  onPicked,
  onError,
}: {
  grantId: string | null
  pickerConfigured: boolean
  disabled?: boolean
  label?: string
  onPicked: (folder: { id: string; name: string }) => void
  onError?: (message: string) => void
}) {
  const [pending, startTransition] = useTransition()

  const open = useCallback(() => {
    if (!grantId) {
      onError?.('Előbb kösd be a Google Drive-ot a Kapcsolt fiókok oldalon.')
      return
    }
    if (!pickerConfigured) {
      onError?.('A Google Picker nincs platform-szinten beállítva.')
      return
    }
    startTransition(async () => {
      try {
        const sessionRes = await getGoogleDrivePickerSession({ grantId })
        if (!sessionRes.success) {
          onError?.(sessionRes.error)
          return
        }
        await ensureGooglePickerLoaded()
        await openGoogleDriveFolderPicker(sessionRes.data, (folder) => onPicked(folder))
      } catch (e) {
        onError?.(e instanceof Error ? e.message : 'A Picker nem nyitható meg.')
      }
    })
  }, [grantId, onError, onPicked, pickerConfigured])

  return (
    <button
      type="button"
      disabled={disabled || pending || !grantId || !pickerConfigured}
      className="rounded-full border border-coral/40 px-3.5 py-1.5 text-xs font-semibold text-coral-deep transition-colors hover:bg-coral/5 disabled:opacity-50"
      onClick={open}
    >
      {pending ? 'Betöltés…' : label}
    </button>
  )
}
