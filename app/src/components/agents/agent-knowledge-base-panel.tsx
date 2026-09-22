'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  attachKnowledgeCatalogDocument,
  deleteKbDocument,
  ingestKbDocument,
} from '@/app/actions/platform'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { Card } from '@/components/ui/shell'
import {
  KB_PROCESSING_MODE_OPTIONS,
  kbProcessingModeLabel,
  type KbProcessingModeValue,
} from '@/lib/kb-processing-mode-labels'

export type KbDocumentRow = {
  id: string
  filename: string
  status: string
  processingMode: KbProcessingModeValue | null
  purpose: string | null
  createdAt: Date | string
}

export function AgentKnowledgeBasePanel({
  agentId,
  documents,
  catalog = [],
  canManage,
}: {
  agentId: string
  documents: KbDocumentRow[]
  /** Közös katalógus-elemek — innen másolható az agenthez, mint a konnektorok. */
  catalog?: KbDocumentRow[]
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [mode, setMode] = useState<KbProcessingModeValue>('raw_text_only')
  const [fileName, setFileName] = useState<string | null>(null)
  const attachedNames = useMemo(() => new Set(documents.map((doc) => doc.filename)), [documents])
  const unattachedCatalog = useMemo(
    () => catalog.filter((doc) => !attachedNames.has(doc.filename)),
    [catalog, attachedNames],
  )
  const [catalogId, setCatalogId] = useState('')

  function refresh() {
    router.refresh()
  }

  return (
    <Card title="Tudásbázis">
      <p className="mb-4 text-xs text-ink-faint">
        Az agent először a katalógust látja (fájlnév, mire való, méret), és csak egy oldalt
        vagy egy fájlt nyit meg. A „mire való” sor segít választani anélkül, hogy belenézne.
      </p>
      {canManage ? (
        <form
          className="mb-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            const form = event.currentTarget
            const data = new FormData(form)
            data.set('agentId', agentId)
            data.set('processingMode', mode)
            start(async () => {
              setError(null)
              const res = await ingestKbDocument(data)
              if (res.success) {
                form.reset()
                setFileName(null)
                setDone(`„${res.data.filename}” feltöltve.`)
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
      {error ? <p className="mb-3 text-sm text-coral-deep">{error}</p> : null}
      {done ? (
        <p className="mb-3 rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
          {done}
        </p>
      ) : null}
      {documents.length === 0 ? (
        <p className="text-sm text-ink-soft">Még nincs dokumentum.</p>
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
                        title: 'Dokumentum törlése',
                        description: `Törlöd: ${doc.filename}?`,
                        tone: 'danger',
                        confirmLabel: 'Törlés',
                      })
                      if (!ok) return
                      const res = await deleteKbDocument({ agentId, documentId: doc.id })
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
      {canManage ? (
        <div className="mt-5 border-t border-line/70 pt-4">
          <p className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
            Hozzákötés a katalógusból
          </p>
          <p className="mb-3 text-xs text-ink-faint">
            A kiválasztott elem másolatként kerül az agenthez — a későbbi
            katalógus-frissítés nem írja át.
          </p>
          {unattachedCatalog.length === 0 ? (
            <p className="text-xs text-ink-faint">
              Nincs több hozzáköthető katalógus-elem.{' '}
              <Link href="/control-plane/knowledge" className="font-medium text-coral">
                Megnyitás a katalógusban
              </Link>
            </p>
          ) : (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (!catalogId) return
                start(async () => {
                  setError(null)
                  setDone(null)
                  const res = await attachKnowledgeCatalogDocument({
                    agentId,
                    documentId: catalogId,
                  })
                  if (!res.success) {
                    setError(res.error)
                    return
                  }
                  setDone(`„${res.data.filename}” hozzákötve a katalógusból.`)
                  setCatalogId('')
                  refresh()
                })
              }}
            >
              <label className="min-w-[12rem] flex-1 text-sm">
                <span className="text-ink-soft">Katalógus-elem</span>
                <select
                  className="mt-1 block w-full rounded-lg border border-line bg-paper px-3 py-2"
                  value={catalogId}
                  onChange={(e) => setCatalogId(e.target.value)}
                  required
                >
                  <option value="">nincs kiválasztva</option>
                  {unattachedCatalog.map((doc) => (
                    <option key={doc.id} value={doc.id}>
                      {doc.filename} ({kbProcessingModeLabel(doc.processingMode)})
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                disabled={pending || !catalogId}
                className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {pending ? 'Kötés…' : 'Hozzákötés'}
              </button>
            </form>
          )}
        </div>
      ) : null}
    </Card>
  )
}
