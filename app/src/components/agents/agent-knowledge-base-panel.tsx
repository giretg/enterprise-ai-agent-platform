'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import {
  listDocumentsForAgent,
  processDocumentForWiki,
  uploadDocument,
} from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

type KbDocument = { id: string; filename: string; status: string; createdAt: Date | string }

export function AgentKnowledgeBasePanel({
  agentId,
  agentName,
  isOrchestrator,
  canUpload,
}: {
  agentId: string
  agentName: string
  isOrchestrator: boolean
  canUpload: boolean
}) {
  const [uploadPending, startUpload] = useTransition()
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const [kbDocs, setKbDocs] = useState<KbDocument[]>([])
  const [textInput, setTextInput] = useState('')
  const [loading, setLoading] = useState(true)

  const refreshDocs = useCallback(() => {
    if (isOrchestrator) {
      setKbDocs([])
      setLoading(false)
      return
    }
    setLoading(true)
    listDocumentsForAgent({ agentId }).then((res) => {
      if (res.success) setKbDocs(res.data as KbDocument[])
      setLoading(false)
    })
  }, [agentId, isOrchestrator])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      refreshDocs()
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [refreshDocs])

  const handleUpload = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!canUpload) return
    setUploadMessage(null)

    const form = e.currentTarget
    const fileInput = form.querySelector<HTMLInputElement>('input[type="file"]')
    const file = fileInput?.files?.[0]

    startUpload(async () => {
      const fd = new FormData()
      if (textInput.trim()) {
        fd.append('text', textInput)
      } else if (file) {
        fd.append('file', file)
      } else {
        setUploadMessage('Nincs feltöltendő fájl vagy szöveg.')
        return
      }

      const uploadRes = await uploadDocument(fd)
      if (!uploadRes.success) {
        setUploadMessage(uploadRes.error)
        return
      }

      const processRes = await processDocumentForWiki({
        documentId: (uploadRes.data as { id: string }).id,
        agentId,
      })
      if (!processRes.success) {
        setUploadMessage(processRes.error)
        return
      }

      setUploadMessage(`Hozzáadva a tudásbázishoz: ${file?.name ?? 'szöveg'}`)
      setTextInput('')
      if (fileInput) fileInput.value = ''
      refreshDocs()
    })
  }

  if (isOrchestrator) {
    return (
      <Card title="Tudásbázis">
        <p className="text-sm leading-relaxed text-ink-soft">
          Az orchestrator agentek szándékosan tool-less módban futnak — nincs dedikált tudásbázisuk.
          Worker agentekhez tölts fel dokumentumokat.
        </p>
      </Card>
    )
  }

  return (
    <Card title="Tudásbázis">
      <p className="mb-4 text-sm leading-relaxed text-ink-soft">
        A feltöltött szövegek a(z) <span className="font-medium text-ink">{agentName}</span> agent
        saját tudásbázisába kerülnek. A <code className="rounded bg-night-2 px-1 py-0.5 text-xs">kb_search</code>{' '}
        eszközzel keresi őket válaszadáskor.
      </p>

      {canUpload ? (
        <form onSubmit={handleUpload} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-soft">Fájl (.txt, .md, .csv)</label>
            <input
              type="file"
              accept=".txt,.md,.csv"
              className="w-full text-sm text-ink-soft file:mr-3 file:rounded-full file:border-0 file:bg-sage/20 file:px-4 file:py-1.5 file:text-xs file:font-semibold file:text-sage"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-soft">
              Vagy illessz be szöveget közvetlenül
            </label>
            <textarea
              className="w-full rounded-xl border border-line bg-night-2 p-3 font-mono text-sm text-ink focus:border-coral/50 focus:outline-none"
              rows={4}
              placeholder="Ide illeszt be szöveget..."
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={uploadPending}
            className="rounded-full bg-honey/20 px-5 py-2.5 text-sm font-semibold text-honey hover:bg-honey/30 disabled:opacity-50"
          >
            {uploadPending ? 'Feltöltés...' : '+ Hozzáadás a tudásbázishoz'}
          </button>
          {uploadMessage && <p className="text-sm text-ink-soft">{uploadMessage}</p>}
        </form>
      ) : (
        <p className="text-sm text-ink-faint">
          Feltöltéshez operator vagy admin jogosultság szükséges.
        </p>
      )}

      <div className="mt-4 border-t border-line pt-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-widest text-ink-faint">
          Dokumentumok ({loading ? '…' : kbDocs.length})
        </p>
        {loading ? (
          <p className="text-sm text-ink-faint">Betöltés...</p>
        ) : kbDocs.length === 0 ? (
          <p className="text-sm text-ink-faint">Még nincs dokumentum ebben a tudásbázisban.</p>
        ) : (
          <ul className="space-y-1">
            {kbDocs.map((doc) => (
              <li key={doc.id} className="flex items-center gap-2 text-sm text-ink-soft">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sage" />
                <span className="truncate" title={doc.filename}>
                  {doc.filename}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}
