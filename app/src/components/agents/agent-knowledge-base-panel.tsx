'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { deleteKbDocument, ingestKbDocument } from '@/app/actions/platform'
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
  createdAt: Date | string
}

export function AgentKnowledgeBasePanel({
  agentId,
  documents,
  canManage,
}: {
  agentId: string
  documents: KbDocumentRow[]
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<KbProcessingModeValue>('raw_text_only')

  function refresh() {
    router.refresh()
  }

  return (
    <Card title="Tudásbázis">
      <p className="mb-4 text-xs text-ink-faint">
        Fájl feltöltése MCP-n (`kb_ingest`) vagy innen. Sima fájl kereshető marad; wiki
        módban oldalakra bontjuk (`kb_list_index`, `kb_get_page`).
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
                refresh()
              } else {
                setError(res.error)
              }
            })
          }}
        >
          <input type="file" name="file" required className="block w-full text-sm" />
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
    </Card>
  )
}
