'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  deleteKnowledgeCatalogDocument,
  ingestKnowledgeCatalogDocument,
  setKnowledgeCatalogDocumentLanguage,
} from '@/app/actions/platform'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import {
  KB_PROCESSING_MODE_OPTIONS,
  type KbProcessingModeValue,
} from '@/lib/kb-processing-mode-labels'
import { KB_LANGUAGE_OPTIONS, isKbLanguage } from '@/lib/kb-language'

/** A közös tudásbázis feltöltője a Fájlok fülön. */
export function KnowledgeCatalogUploadForm() {
  const t = useTranslations('Knowledge')
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [mode, setMode] = useState<KbProcessingModeValue>('raw_text_only')
  const [fileName, setFileName] = useState<string | null>(null)

  return (
    <form
      className="mb-4 space-y-3"
      data-testid="kb-catalog-upload"
      onSubmit={(event) => {
        event.preventDefault()
        const form = event.currentTarget
        const data = new FormData(form)
        data.set('processingMode', mode)
        start(async () => {
          setError(null)
          setDone(null)
          const res = await ingestKnowledgeCatalogDocument(data)
          if (res.success) {
            form.reset()
            setFileName(null)
            setDone(t('uploaded', { filename: res.data.filename }))
            router.refresh()
          } else {
            setError(res.error)
          }
        })
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-coral px-3 py-1.5 text-sm font-medium text-white hover:bg-coral/90">
          {t('chooseFile')}
          <input
            type="file"
            name="file"
            required
            className="hidden"
            onChange={(event) => setFileName(event.target.files?.[0]?.name ?? null)}
          />
        </label>
        <span className="text-sm text-ink-soft">{fileName ?? t('noFile')}</span>
      </div>
      {fileName ? (
        <>
          <fieldset className="space-y-2">
            {KB_PROCESSING_MODE_OPTIONS.map((option) => (
              <label key={option.value} className="flex gap-2 text-sm">
                <input
                  type="radio"
                  name="processingMode"
                  value={option.value}
                  checked={mode === option.value}
                  onChange={() => setMode(option.value)}
                />
                <span>
                  <span className="font-medium">{option.value === 'raw_text_only' ? t('modeRaw') : t('modeWiki')}</span>
                  <span className="block text-xs text-ink-faint">
                    {option.value === 'raw_text_only' ? t('modeRawDesc') : t('modeWikiDesc')}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-ink-faint">{t('purpose')}</span>
            <input name="purpose" maxLength={240} className="w-full rounded-lg border border-line/70 px-3 py-1.5 text-sm" />
          </label>
          <button type="submit" disabled={pending} className="rounded-lg bg-coral px-3 py-1.5 text-sm text-white disabled:opacity-50">
            {t('upload')}
          </button>
        </>
      ) : null}
      {done ? <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">{done}</p> : null}
      {error ? <p className="text-sm text-coral-deep">{error}</p> : null}
    </form>
  )
}

/** Egy közös fájl keresési nyelve és törlése a Fájlok fülön. */
export function KnowledgeCatalogFileControls({
  documentId,
  filename,
  kbLanguageOverride,
}: {
  documentId: string
  filename: string
  /** `null` = a tudástár nyelvét örökli. */
  kbLanguageOverride: string | null
}) {
  const t = useTranslations('Knowledge')
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <span className="flex flex-wrap items-center gap-2">
      {error ? <span className="text-xs text-coral-deep">{error}</span> : null}
      <label className="flex items-center gap-1 text-xs text-ink-faint">
        {t('docLanguageLabel')}
        <select
          disabled={pending}
          value={isKbLanguage(kbLanguageOverride) ? kbLanguageOverride : ''}
          onChange={(event) => {
            const value = event.target.value
            start(async () => {
              setError(null)
              const res = await setKnowledgeCatalogDocumentLanguage({
                documentId,
                kbLanguageOverride: value === '' ? null : value,
              })
              if (res.success) router.refresh()
              else setError(res.error)
            })
          }}
          className="rounded-md border border-line/70 bg-panel px-1.5 py-1 text-xs"
        >
          <option value="">{t('docLanguageInherited')}</option>
          {KB_LANGUAGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={pending}
        className="text-xs text-coral-deep"
        onClick={() => {
          start(async () => {
            setError(null)
            const ok = await confirmDialog({
              title: t('deleteTitle'),
              description: t('deleteBody', { filename }),
              tone: 'danger',
              confirmLabel: t('delete'),
            })
            if (!ok) return
            const res = await deleteKnowledgeCatalogDocument({ documentId })
            if (res.success) router.refresh()
            else setError(res.error)
          })
        }}
      >
        {t('delete')}
      </button>
    </span>
  )
}
