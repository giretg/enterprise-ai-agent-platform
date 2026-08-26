'use client'

import { useCallback, useState, useTransition } from 'react'
import {
  approveKbDocument,
  deleteKbDocument,
  getKnowledgeBaseSharing,
  listAgents,
  listDocumentsForAgent,
  listKbDocumentRequests,
  rejectKbDocument,
  requestKbDocument,
  shareKnowledgeBaseWithAgent,
  unshareKnowledgeBaseFromAgent,
  uploadDocument,
} from '@/app/actions/platform'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { Card } from '@/components/ui/shell'
import { KbArtifactReview } from '@/components/agents/kb-artifact-review'
import type { AgentDetailKbInitial } from '@/lib/agent-detail-page-data'

type KbDocument = { id: string; filename: string; status: string; createdAt: Date | string }
type PendingDoc = { ticketId: string; documentId: string; filename: string; createdAt: Date | string }
type AgentOption = { id: string; name: string; role: string }
type SharedAgent = { id: string; name: string }
type KnowledgeProcessingMode = 'raw_text_only' | 'okf'

export function AgentKnowledgeBasePanel({
  agentId,
  agentName,
  isOrchestrator,
  canUpload,
  canApprove,
  initialData,
}: {
  agentId: string
  agentName: string
  isOrchestrator: boolean
  canUpload: boolean
  canApprove: boolean
  initialData?: AgentDetailKbInitial
}) {
  const [uploadPending, startUpload] = useTransition()
  const [actionPending, startAction] = useTransition()
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const [kbDocs, setKbDocs] = useState<KbDocument[]>(initialData?.kbDocs ?? [])
  const [pendingDocs, setPendingDocs] = useState<PendingDoc[]>(initialData?.pendingDocs ?? [])
  const [sharedWith, setSharedWith] = useState<SharedAgent[]>(initialData?.sharedWith ?? [])
  const [agentOptions, setAgentOptions] = useState<AgentOption[]>(initialData?.agentOptions ?? [])
  const [shareTargetId, setShareTargetId] = useState('')
  const [textInput, setTextInput] = useState('')
  const [processingMode, setProcessingMode] = useState<KnowledgeProcessingMode>('raw_text_only')
  const [loading, setLoading] = useState(!initialData)
  const [reviewDoc, setReviewDoc] = useState<PendingDoc | null>(null)

  const refreshDocs = useCallback(() => {
    if (isOrchestrator) {
      setKbDocs([])
      setPendingDocs([])
      setLoading(false)
      return
    }
    setLoading(true)
    Promise.all([
      listDocumentsForAgent({ agentId }),
      listKbDocumentRequests({ agentId }),
      getKnowledgeBaseSharing({ agentId }),
    ]).then(([docsRes, pendingRes, shareRes]) => {
      if (docsRes.success) setKbDocs(docsRes.data as KbDocument[])
      if (pendingRes.success) setPendingDocs(pendingRes.data as PendingDoc[])
      if (shareRes.success) {
        setSharedWith((shareRes.data as { sharedWithAgents: SharedAgent[] }).sharedWithAgents)
      }
      setLoading(false)
    })
  }, [agentId, isOrchestrator])

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

      const requestRes = await requestKbDocument({
        documentId: (uploadRes.data as { id: string }).id,
        agentId,
        processingMode,
      })
      if (!requestRes.success) {
        setUploadMessage(requestRes.error)
        return
      }

      setUploadMessage(
        processingMode === 'okf'
          ? `Feltöltve OKF review-ra — jóváhagyásra vár: ${file?.name ?? 'szöveg'}`
          : `Feltöltve — jóváhagyásra vár: ${file?.name ?? 'szöveg'}`,
      )
      setTextInput('')
      if (fileInput) fileInput.value = ''
      refreshDocs()
    })
  }

  const handleApprove = (ticketId: string) => {
    startAction(async () => {
      const res = await approveKbDocument({ ticketId })
      setUploadMessage(res.success ? 'Jóváhagyva — bekerült a tudásbázisba.' : res.error)
      if (res.success) refreshDocs()
    })
  }

  const handleReject = (ticketId: string) => {
    startAction(async () => {
      const res = await rejectKbDocument({ ticketId })
      setUploadMessage(res.success ? 'Elutasítva.' : res.error)
      if (res.success) refreshDocs()
    })
  }

  const handleShare = () => {
    if (!shareTargetId) return
    startAction(async () => {
      const res = await shareKnowledgeBaseWithAgent({ agentId, targetAgentId: shareTargetId })
      setUploadMessage(res.success ? 'Megosztva a kiválasztott agenttel.' : res.error)
      if (res.success) {
        setShareTargetId('')
        refreshDocs()
      }
    })
  }

  const handleUnshare = (targetAgentId: string) => {
    startAction(async () => {
      const res = await unshareKnowledgeBaseFromAgent({ agentId, targetAgentId })
      setUploadMessage(res.success ? 'Megosztás visszavonva.' : res.error)
      if (res.success) refreshDocs()
    })
  }

  const handleDelete = (documentId: string, filename: string) => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: 'Dokumentum törlése',
        description: `Biztosan törlöd: ${filename}?`,
        confirmLabel: 'Törlés',
        tone: 'danger',
      })
      if (!confirmed) return
      startAction(async () => {
        const res = await deleteKbDocument({ agentId, documentId })
        setUploadMessage(res.success ? 'Dokumentum törölve.' : res.error)
        if (res.success) refreshDocs()
      })
    })()
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

  const shareableAgents = agentOptions.filter(
    (a) => a.id !== agentId && a.role !== 'orchestrator' && !sharedWith.some((s) => s.id === a.id),
  )

  return (
    <>
    {reviewDoc && (
      <KbArtifactReview
        agentId={agentId}
        documentId={reviewDoc.documentId}
        canApprove={canApprove}
        actionPending={actionPending}
        onApprove={(ticketId) => {
          setReviewDoc(null)
          handleApprove(ticketId)
        }}
        onReject={(ticketId) => {
          setReviewDoc(null)
          handleReject(ticketId)
        }}
        onClose={() => setReviewDoc(null)}
      />
    )}
    <Card title="Tudásbázis">
      <p className="mb-4 text-sm leading-relaxed text-ink-soft">
        A feltöltött szövegek a(z) <span className="font-medium text-ink">{agentName}</span> agent
        saját tudásbázisába kerülnek, <span className="font-medium text-ink">jóváhagyás után</span>. A{' '}
        <code className="rounded bg-night-2 px-1 py-0.5 text-xs">kb_search</code> eszközzel keresi
        őket válaszadáskor.
      </p>

      {canUpload ? (
        <form onSubmit={handleUpload} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-soft">Fájl (.txt, .md, .csv, .xlsx, .docx, .pdf)</label>
            <input
              type="file"
              accept=".txt,.md,.csv,.json,.xlsx,.xlsm,.docx,.pdf"
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
          <div>
            <p className="mb-1 block text-xs font-medium text-ink-soft">Feldolgozás</p>
            <div className="inline-flex rounded-full border border-line bg-night-2 p-1">
              {[
                { value: 'raw_text_only' as const, label: 'Nyers KB' },
                { value: 'okf' as const, label: 'OKF wiki' },
              ].map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  onClick={() => setProcessingMode(mode.value)}
                  className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${
                    processingMode === mode.value
                      ? 'bg-sage/20 text-sage'
                      : 'text-ink-faint hover:text-ink-soft'
                  }`}
                  aria-pressed={processingMode === mode.value}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>
          <button
            type="submit"
            disabled={uploadPending}
            className="rounded-full bg-honey/20 px-5 py-2.5 text-sm font-semibold text-honey hover:bg-honey/30 disabled:opacity-50"
          >
            {uploadPending
              ? 'Feltöltés...'
              : processingMode === 'okf'
                ? '+ Beküldés OKF review-ra'
                : '+ Beküldés jóváhagyásra'}
          </button>
          {uploadMessage && <p className="text-sm text-ink-soft">{uploadMessage}</p>}
        </form>
      ) : (
        <p className="text-sm text-ink-faint">
          Feltöltéshez operator vagy admin jogosultság szükséges.
        </p>
      )}

      {pendingDocs.length > 0 && (
        <div className="mt-4 border-t border-line pt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-widest text-ink-faint">
            Jóváhagyásra vár ({pendingDocs.length})
          </p>
          <ul className="space-y-2">
            {pendingDocs.map((doc) => (
              <li
                key={doc.ticketId}
                className="flex items-center justify-between gap-2 text-sm text-ink-soft"
              >
                <span className="flex items-center gap-2 truncate">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-honey" />
                  <span className="truncate" title={doc.filename}>
                    {doc.filename}
                  </span>
                </span>
                <span className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => setReviewDoc(doc)}
                    className="rounded-full bg-sky/20 px-3 py-1 text-xs font-semibold text-sky hover:bg-sky/30"
                  >
                    Áttekintés
                  </button>
                  {canApprove ? (
                    <>
                      <button
                        type="button"
                        disabled={actionPending}
                        onClick={() => handleApprove(doc.ticketId)}
                        className="rounded-full bg-sage/20 px-3 py-1 text-xs font-semibold text-sage hover:bg-sage/30 disabled:opacity-50"
                      >
                        Jóváhagyás
                      </button>
                      <button
                        type="button"
                        disabled={actionPending}
                        onClick={() => handleReject(doc.ticketId)}
                        className="rounded-full bg-coral/20 px-3 py-1 text-xs font-semibold text-coral hover:bg-coral/30 disabled:opacity-50"
                      >
                        Elutasítás
                      </button>
                    </>
                  ) : (
                    <span className="self-center text-xs text-ink-faint">approver hagyja jóvá</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 border-t border-line pt-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-widest text-ink-faint">
          Dokumentumok ({loading ? '…' : kbDocs.length})
        </p>
        {loading ? (
          <p className="text-sm text-ink-faint">Betöltés...</p>
        ) : kbDocs.length === 0 ? (
          <p className="text-sm text-ink-faint">
            Még nincs jóváhagyott dokumentum ebben a tudásbázisban.
          </p>
        ) : (
          <ul className="space-y-1">
            {kbDocs.map((doc) => (
              <li key={doc.id} className="flex items-center justify-between gap-2 text-sm text-ink-soft">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sage" />
                  <span className="truncate" title={doc.filename}>
                    {doc.filename}
                  </span>
                </span>
                {canUpload && (
                  <button
                    type="button"
                    disabled={actionPending}
                    onClick={() => handleDelete(doc.id, doc.filename)}
                    className="shrink-0 rounded-full bg-coral/20 px-3 py-1 text-xs font-semibold text-coral hover:bg-coral/30 disabled:opacity-50"
                  >
                    Törlés
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {canUpload && (
        <div className="mt-4 border-t border-line pt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-widest text-ink-faint">
            Megosztás{sharedWith.length > 0 ? ` (${sharedWith.length} agent)` : ''}
          </p>
          {sharedWith.length > 0 && (
            <ul className="mb-3 space-y-1">
              {sharedWith.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-2 text-xs text-ink-faint"
                >
                  <span className="truncate" title={s.name}>
                    {s.name}
                  </span>
                  <button
                    type="button"
                    disabled={actionPending}
                    onClick={() => handleUnshare(s.id)}
                    className="shrink-0 rounded-full bg-night-2 px-3 py-1 text-xs font-semibold text-coral hover:bg-coral/20 disabled:opacity-50"
                  >
                    Visszavonás
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <select
              value={shareTargetId}
              onChange={(e) => setShareTargetId(e.target.value)}
              className="flex-1 rounded-xl border border-line bg-night-2 p-2 text-sm text-ink focus:border-coral/50 focus:outline-none"
            >
              <option value="">Másik agent kiválasztása…</option>
              {shareableAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={actionPending || !shareTargetId}
              onClick={handleShare}
              className="rounded-full bg-night-2 px-4 py-2 text-sm font-semibold text-ink-soft hover:text-ink disabled:opacity-50"
            >
              Megosztás
            </button>
          </div>
        </div>
      )}
    </Card>
    </>
  )
}
