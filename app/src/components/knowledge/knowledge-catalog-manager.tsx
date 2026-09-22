'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  deleteKnowledgeCatalogDocument,
  ingestKnowledgeCatalogDocument,
} from '@/app/actions/platform'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { Card } from '@/components/ui/shell'
import {
  KB_PROCESSING_MODE_OPTIONS,
  kbProcessingModeLabel,
  type KbProcessingModeValue,
} from '@/lib/kb-processing-mode-labels'

export type KnowledgeCatalogRow = {
  id: string
  filename: string
  status: string
  processingMode: KbProcessingModeValue | null
  purpose: string | null
  createdAt: Date | string
}

export function KnowledgeCatalogManager({
  documents,
  canManage,
}: {
  documents: KnowledgeCatalogRow[]
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [mode, setMode] = useState<KbProcessingModeValue>('raw_text_only')
  const [fileName, setFileName] = useState<string | null>(null)

  function refresh() {
    router.refresh()
  }

  return (
    <Card title="Katalógus-elemek">
      {canManage ? (
        <form
          className="mb-4 space-y-3"
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
                setDone(`„${res.data.filename}” feltöltve a katalógusba.`)
                refresh()
              } else {
                setError(res.error)
              }
            })
          }}
        >
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-coral px-3 py-1.5 text-sm font-medium text-white hover:bg-coral/90">
              Fájl kiválasztása
              <input
                type="file"
                name="file"
                required
                className="hidden"
                onChange={(event) => setFileName(event.target.files?.[0]?.name ?? null)}
              />
            </label>
            <span className="text-sm text-ink-soft">{fileName ?? 'Nincs fájl kiválasztva'}</span>
          </div>
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
                  <span className="font-medium">{option.label}</span>
                  <span className="block text-xs text-ink-faint">{option.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-ink-faint">Mire való (egy sor, opcionális)</span>
            <input
              name="purpose"
              maxLength={240}
              className="w-full rounded-lg border border-line/70 px-3 py-1.5 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-coral px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            Feltöltés
          </button>
        </form>
      ) : null}
      {done ? (
        <p className="mb-3 rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
          {done}
        </p>
      ) : null}
      {error ? <p className="mb-3 text-sm text-coral-deep">{error}</p> : null}
      {documents.length === 0 ? (
        <p className="text-sm text-ink-soft">Még nincs katalógus-elem.</p>
      ) : (
        <ul className="space-y-2">
          {documents.map((doc) => (
            <li
              key={doc.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line/70 px-3 py-2 text-sm"
            >
              <span>
                {doc.filename}{' '}
                <span className="text-xs text-ink-faint">
                  ({kbProcessingModeLabel(doc.processingMode)} · {doc.status})
                </span>
                {doc.purpose ? (
                  <span className="block text-xs text-ink-faint">{doc.purpose}</span>
                ) : null}
              </span>
              {canManage ? (
                <button
                  type="button"
                  disabled={pending}
                  className="text-xs text-coral-deep"
                  onClick={() => {
                    start(async () => {
                      const ok = await confirmDialog({
                        title: 'Katalógus-elem törlése',
                        description: `Törlöd: ${doc.filename}? Az agenteknél lévő másolatok megmaradnak.`,
                        tone: 'danger',
                        confirmLabel: 'Törlés',
                      })
                      if (!ok) return
                      const res = await deleteKnowledgeCatalogDocument({ documentId: doc.id })
                      if (res.success) refresh()
                      else setError(res.error)
                    })
                  }}
                >
                  Törlés
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
