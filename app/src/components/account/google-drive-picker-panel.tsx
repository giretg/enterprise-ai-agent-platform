'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useState, useTransition } from 'react'
import {
  getGoogleDrivePickerSession,
  removeGoogleDrivePickerSelectionAction,
  saveGoogleDrivePickerSelections,
} from '@/app/actions/connector-grants'
import type { GoogleDriveGrantMetadata } from '@/domain/connector-grant/google-drive-grant-metadata'

type PickerDoc = {
  id: string
  name: string
  mimeType: string
}

declare global {
  interface Window {
    gapi?: {
      load: (api: string, callback: () => void) => void
    }
    google?: {
      picker: {
        Action: { PICKED: string; CANCEL: string }
        DocsView: new () => PickerDocsView
        PickerBuilder: new () => PickerBuilderInstance
        Feature: { MULTISELECT_ENABLED: string; SUPPORT_DRIVES: string }
      }
    }
  }
}

type PickerDocsView = {
  setIncludeFolders: (include: boolean) => PickerDocsView
  setSelectFolderEnabled: (enabled: boolean) => PickerDocsView
  setMimeTypes: (mimeTypes: string) => PickerDocsView
}

type PickerBuilderInstance = {
  setAppId: (appId: string) => PickerBuilderInstance
  setOAuthToken: (token: string) => PickerBuilderInstance
  setDeveloperKey: (key: string) => PickerBuilderInstance
  setOrigin: (origin: string) => PickerBuilderInstance
  enableFeature: (feature: string) => PickerBuilderInstance
  addView: (view: PickerDocsView) => PickerBuilderInstance
  setCallback: (
    cb: (data: { action: string; docs?: PickerDoc[] }) => void,
  ) => PickerBuilderInstance
  build: () => { setVisible: (visible: boolean) => void }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.body.appendChild(script)
  })
}

async function ensurePickerLoaded(): Promise<void> {
  await loadScript('https://apis.google.com/js/api.js')
  await new Promise<void>((resolve, reject) => {
    if (!window.gapi) {
      reject(new Error('Google API script failed to initialize'))
      return
    }
    window.gapi.load('picker', () => resolve())
  })
}

export function selectionLabel(mimeType: string): string {
  return mimeType === 'application/vnd.google-apps.folder' ? 'mappa' : 'fájl'
}

export function GoogleDrivePickerPanel({
  grantId,
  initialMetadata,
  pickerConfigured,
}: {
  grantId: string
  initialMetadata: GoogleDriveGrantMetadata
  pickerConfigured: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [metadata, setMetadata] = useState(initialMetadata)

  const openPicker = useCallback(() => {
    setMessage(null)
    startTransition(async () => {
      try {
        const sessionRes = await getGoogleDrivePickerSession({ grantId })
        if (!sessionRes.success) {
          setMessage({ ok: false, text: sessionRes.error })
          return
        }
        await ensurePickerLoaded()
        const { accessToken, apiKey, appId, origin } = sessionRes.data
        const pickerApi = window.google?.picker
        if (!pickerApi) {
          setMessage({ ok: false, text: 'A Google Picker API nem töltődött be.' })
          return
        }

        const docsView = new pickerApi.DocsView()
        docsView.setIncludeFolders(true)
        docsView.setSelectFolderEnabled(true)

        const picker = new pickerApi.PickerBuilder()
        picker.setAppId(appId)
        picker.setOAuthToken(accessToken)
        picker.setDeveloperKey(apiKey)
        picker.setOrigin(origin)
        picker.enableFeature(pickerApi.Feature.MULTISELECT_ENABLED)
        picker.enableFeature(pickerApi.Feature.SUPPORT_DRIVES)
        picker.addView(docsView)
        picker.setCallback(async (data: { action: string; docs?: PickerDoc[] }) => {
            if (data.action !== pickerApi.Action.PICKED || !data.docs?.length) return
            const saveRes = await saveGoogleDrivePickerSelections({
              grantId,
              selections: data.docs.map((doc: PickerDoc) => ({
                fileId: doc.id,
                name: doc.name,
                mimeType: doc.mimeType,
              })),
            })
            if (saveRes.success) {
              setMetadata(saveRes.data.metadata)
              setMessage({
                ok: true,
                text: `${data.docs.length} írható cél mentve.`,
              })
              router.refresh()
            } else {
              setMessage({ ok: false, text: saveRes.error })
            }
          })
        picker.build().setVisible(true)
      } catch (e) {
        setMessage({
          ok: false,
          text: e instanceof Error ? e.message : 'A Picker megnyitása sikertelen.',
        })
      }
    })
  }, [grantId, router])

  const removeSelection = (fileId: string) => {
    setMessage(null)
    startTransition(async () => {
      const res = await removeGoogleDrivePickerSelectionAction({ grantId, fileId })
      if (res.success) {
        setMetadata(res.data.metadata)
        router.refresh()
      } else {
        setMessage({ ok: false, text: res.error })
      }
    })
  }

  const selections = metadata.pickerSelections

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-xs leading-5 text-ink-soft">
          Ezeket a fájlokat és mappákat módosíthatja az agent. Az általa létrehozott fájlok
          automatikusan írhatók.
        </p>
        <button
          type="button"
          disabled={pending || !pickerConfigured}
          className="rounded-full border border-coral/40 px-3.5 py-1.5 text-xs font-semibold text-coral-deep transition-colors hover:bg-coral/5 disabled:opacity-50"
          onClick={openPicker}
        >
          {pending ? 'Betöltés…' : '+ Fájlok kiválasztása'}
        </button>
      </div>

      {!pickerConfigured ? (
        <p className="rounded-lg bg-honey/10 px-3 py-2 text-xs leading-5 text-ink-soft">
          A fájlválasztó még nincs beállítva a platformon. Kérd meg az admint, hogy adja meg a
          Picker API kulcsot és az App ID-t a{' '}
          <span className="font-medium text-ink">Platform → Beállítások → Google Drive OAuth</span>{' '}
          szekcióban.
        </p>
      ) : null}

      {selections.length > 0 ? (
        <ul className="space-y-2">
          {selections.map((entry) => (
            <li
              key={entry.fileId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line/60 px-3 py-2 text-sm"
              title={entry.fileId}
            >
              <span>
                <span className="font-medium text-ink">{entry.name}</span>
                <span className="ml-2 text-xs text-ink-faint">{selectionLabel(entry.mimeType)}</span>
              </span>
              <button
                type="button"
                disabled={pending}
                className="text-xs font-semibold text-coral-deep disabled:opacity-50"
                onClick={() => removeSelection(entry.fileId)}
              >
                Eltávolítás
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-ink-faint">Még nincs kiválasztott írható fájl vagy mappa.</p>
      )}

      {message ? (
        <p
          className={`rounded-lg border px-3 py-2 text-sm ${
            message.ok
              ? 'border-sage/35 bg-sage/10 text-sage'
              : 'border-coral/35 bg-coral/10 text-coral-deep'
          }`}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  )
}
