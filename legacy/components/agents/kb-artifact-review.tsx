'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getKbArtifactReview, setKbDocumentProcessingMode } from '@/app/actions/platform'
import {
  KB_PROCESSING_MODE_APPROVER_HINT,
  KB_PROCESSING_MODE_OPTIONS,
  type KbProcessingModeValue,
} from '@/lib/kb-processing-mode-labels'

type ValidationIssue = {
  severity: 'error' | 'warning'
  code: string
  path: string
  message: string
}

type Validation = {
  ok: boolean
  pageCount: number
  brokenLinks: number
  externalLinks: number
  sourceLinkCoverage: number
  sensitiveHits: number
  errors: number
  warnings: number
  issues: ValidationIssue[]
}

type ReviewData = {
  filename: string
  processingMode: string | null
  extractedText: string | null
  artifact: { id: string; status: string; version: number; createdAt: string | Date } | null
  files: Array<{ path: string; content: string }>
  validation: Validation | null
  ticketId: string | null
}

/**
 * Jóváhagyói áttekintés: módválasztás + (wiki esetén) hárompaneles artifact-review.
 */
export function KbArtifactReview({
  agentId,
  documentId,
  ticketId,
  canApprove,
  actionPending,
  onApprove,
  onReject,
  onClose,
}: {
  agentId: string
  documentId: string
  ticketId?: string
  canApprove: boolean
  actionPending: boolean
  onApprove: (ticketId: string) => void
  onReject: (ticketId: string) => void
  onClose: () => void
}) {
  const [data, setData] = useState<ReviewData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [modePending, setModePending] = useState(false)
  const [optimisticMode, setOptimisticMode] = useState<KbProcessingModeValue | null>(null)

  const loadReview = useCallback(async () => {
    const res = await getKbArtifactReview({ agentId, documentId })
    if (res.success) {
      const review = res.data as ReviewData
      setData(review)
      setOptimisticMode(null)
      setSelectedPath((current) => {
        if (current && review.files.some((file) => file.path === current)) return current
        return review.files[0]?.path ?? null
      })
      setError(null)
    } else {
      setError(res.error)
    }
  }, [agentId, documentId])

  useEffect(() => {
    let active = true
    getKbArtifactReview({ agentId, documentId }).then((res) => {
      if (!active) return
      if (res.success) {
        const review = res.data as ReviewData
        setData(review)
        setSelectedPath(review.files[0]?.path ?? null)
      } else {
        setError(res.error)
      }
    })
    return () => {
      active = false
    }
  }, [agentId, documentId])

  const resolvedTicketId = data?.ticketId ?? ticketId ?? null
  const processingMode = (optimisticMode ?? data?.processingMode ?? null) as KbProcessingModeValue | null
  const wikiReady = processingMode === 'okf' && data !== null && data.files.length > 0
  const canSubmitApproval =
    canApprove &&
    Boolean(resolvedTicketId) &&
    processingMode !== null &&
    !modePending &&
    (processingMode === 'raw_text_only' || wikiReady)

  const handleSelectMode = async (mode: KbProcessingModeValue) => {
    if (!canApprove || !resolvedTicketId || modePending || actionPending) return
    if (processingMode === mode) return
    setModePending(true)
    setOptimisticMode(mode)
    setError(null)
    const res = await setKbDocumentProcessingMode({
      ticketId: resolvedTicketId,
      processingMode: mode,
    })
    if (!res.success) {
      setError(res.error)
      setOptimisticMode(null)
      setModePending(false)
      return
    }
    await loadReview()
    setModePending(false)
  }

  const selectedFile = useMemo(
    () => data?.files.find((f) => f.path === selectedPath) ?? null,
    [data, selectedPath],
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-line bg-night shadow-xl">
        <header className="border-b border-line px-5 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-widest text-ink-faint">
                Dokumentum áttekintése
              </p>
              <h2 className="truncate font-display text-lg font-semibold text-ink" title={data?.filename}>
                {data?.filename ?? 'Betöltés…'}
                {data?.artifact && processingMode === 'okf' ? (
                  <span className="ml-2 text-sm font-normal text-ink-faint">v{data.artifact.version}</span>
                ) : null}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-full bg-night-2 px-4 py-1.5 text-sm font-semibold text-ink-soft hover:text-ink"
            >
              Bezárás
            </button>
          </div>
          <div className="mt-3">
            <p className="mb-1.5 text-xs font-medium text-ink-soft">Hogyan kerüljön be a tudásbázisba?</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {KB_PROCESSING_MODE_OPTIONS.map((mode) => {
                const selected = processingMode === mode.value
                return (
                  <button
                    key={mode.value}
                    type="button"
                    disabled={!canApprove || modePending || actionPending || !resolvedTicketId}
                    onClick={() => void handleSelectMode(mode.value)}
                    aria-pressed={selected}
                    className={`rounded-xl border px-3 py-2 text-left transition disabled:opacity-60 ${
                      selected
                        ? 'border-sage/40 bg-sage/15'
                        : 'border-line bg-night-2 hover:border-line/80'
                    }`}
                  >
                    <span className={`block text-sm font-semibold ${selected ? 'text-sage' : 'text-ink'}`}>
                      {mode.label}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-ink-faint">
                      {mode.description}
                    </span>
                  </button>
                )
              })}
            </div>
            {!canApprove && (
              <p className="mt-2 text-xs text-ink-faint">{KB_PROCESSING_MODE_APPROVER_HINT}</p>
            )}
            {modePending && (
              <p className="mt-2 text-xs text-ink-soft">Feldolgozási mód beállítása…</p>
            )}
          </div>
        </header>

        {error ? (
          <div className="border-b border-coral/30 px-5 py-2 text-sm text-coral">{error}</div>
        ) : null}
        {!data ? (
          error ? null : <div className="p-6 text-sm text-ink-faint">Áttekintés betöltése…</div>
        ) : processingMode === null ? (
          <div className="p-6 text-sm text-ink-soft">
            Először válaszd ki, hogyan kerüljön be a dokumentum. A jóváhagyás csak utána érhető el.
          </div>
        ) : processingMode === 'raw_text_only' ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <h3 className="border-b border-line px-4 py-2 text-xs font-semibold uppercase tracking-widest text-ink-faint">
                Feltöltött szöveg
              </h3>
              <pre className="flex-1 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-relaxed text-ink-soft">
                {data.extractedText?.trim() || '(nincs kinyert szöveg)'}
              </pre>
            </section>
            {canApprove && resolvedTicketId ? (
              <div className="flex gap-2 border-t border-line px-4 py-3">
                <button
                  type="button"
                  disabled={!canSubmitApproval || actionPending}
                  onClick={() => onApprove(resolvedTicketId)}
                  className="flex-1 rounded-full bg-sage/20 px-3 py-2 text-sm font-semibold text-sage hover:bg-sage/30 disabled:opacity-50"
                >
                  Jóváhagyás
                </button>
                <button
                  type="button"
                  disabled={actionPending || modePending}
                  onClick={() => onReject(resolvedTicketId)}
                  className="flex-1 rounded-full bg-coral/20 px-3 py-2 text-sm font-semibold text-coral hover:bg-coral/30 disabled:opacity-50"
                >
                  Elutasítás
                </button>
              </div>
            ) : !canApprove ? (
              <p className="border-t border-line px-4 py-3 text-xs text-ink-faint">
                A jóváhagyáshoz jóváhagyói jogosultság szükséges.
              </p>
            ) : null}
          </div>
        ) : processingMode === 'okf' && !wikiReady ? (
          <div className="p-6 text-sm text-ink-faint">
            {modePending ? 'Wiki-előnézet készítése…' : 'A wiki-előnézet még nem elérhető.'}
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-px overflow-hidden bg-line lg:grid-cols-3">
            {/* 1. Forrás / extracted text */}
            <section className="flex min-h-0 flex-col overflow-hidden bg-night">
              <h3 className="border-b border-line px-4 py-2 text-xs font-semibold uppercase tracking-widest text-ink-faint">
                Feltöltött szöveg
              </h3>
              <pre className="flex-1 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-relaxed text-ink-soft">
                {data.extractedText?.trim() || '(nincs kinyert szöveg)'}
              </pre>
            </section>

            {/* 2. OKF file-tree + preview */}
            <section className="flex min-h-0 flex-col overflow-hidden bg-night">
              <h3 className="border-b border-line px-4 py-2 text-xs font-semibold uppercase tracking-widest text-ink-faint">
                Wiki oldalak ({data.files.length})
              </h3>
              <div className="flex max-h-40 flex-wrap gap-1 overflow-auto border-b border-line px-3 py-2">
                {data.files.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => setSelectedPath(f.path)}
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      f.path === selectedPath
                        ? 'bg-sage/20 text-sage'
                        : 'bg-night-2 text-ink-faint hover:text-ink-soft'
                    }`}
                    title={f.path}
                  >
                    {f.path}
                  </button>
                ))}
              </div>
              <pre className="flex-1 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-relaxed text-ink-soft">
                {selectedFile?.content ?? '(válassz egy oldalt)'}
              </pre>
            </section>

            {/* 3. Validation report + approve/reject */}
            <section className="flex min-h-0 flex-col overflow-hidden bg-night">
              <h3 className="border-b border-line px-4 py-2 text-xs font-semibold uppercase tracking-widest text-ink-faint">
                Ellenőrzés
              </h3>
              <div className="flex-1 overflow-auto px-4 py-3">
                {data.validation ? (
                  <ValidationReport validation={data.validation} />
                ) : (
                  <p className="text-sm text-ink-faint">Nincs validációs adat.</p>
                )}
              </div>
              {canApprove && resolvedTicketId ? (
                <div className="flex gap-2 border-t border-line px-4 py-3">
                  <button
                    type="button"
                    disabled={!canSubmitApproval || actionPending}
                    onClick={() => onApprove(resolvedTicketId)}
                    className="flex-1 rounded-full bg-sage/20 px-3 py-2 text-sm font-semibold text-sage hover:bg-sage/30 disabled:opacity-50"
                  >
                    Jóváhagyás
                  </button>
                  <button
                    type="button"
                    disabled={actionPending || modePending}
                    onClick={() => onReject(resolvedTicketId)}
                    className="flex-1 rounded-full bg-coral/20 px-3 py-2 text-sm font-semibold text-coral hover:bg-coral/30 disabled:opacity-50"
                  >
                    Elutasítás
                  </button>
                </div>
              ) : !canApprove ? (
                <p className="border-t border-line px-4 py-3 text-xs text-ink-faint">
                  A jóváhagyáshoz jóváhagyói jogosultság szükséges.
                </p>
              ) : null}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

function ValidationReport({ validation }: { validation: Validation }) {
  const coveragePct = Math.round(validation.sourceLinkCoverage * 100)
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            validation.ok ? 'bg-sage/20 text-sage' : 'bg-coral/20 text-coral'
          }`}
        >
          {validation.ok ? 'Strukturálisan rendben' : `${validation.errors} hiba`}
        </span>
        {validation.warnings > 0 && (
          <span className="rounded-full bg-honey/20 px-3 py-1 text-xs font-semibold text-honey">
            {validation.warnings} figyelmeztetés
          </span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs">
        <Metric label="Oldalak" value={String(validation.pageCount)} />
        <Metric
          label="Forrás-lefedettség"
          value={`${coveragePct}%`}
          warn={coveragePct < 100}
        />
        <Metric label="Törött link" value={String(validation.brokenLinks)} warn={validation.brokenLinks > 0} />
        <Metric label="Külső link" value={String(validation.externalLinks)} warn={validation.externalLinks > 0} />
        <Metric
          label="Érzékeny adat"
          value={String(validation.sensitiveHits)}
          warn={validation.sensitiveHits > 0}
        />
      </dl>

      {validation.issues.length > 0 && (
        <ul className="space-y-2">
          {validation.issues.map((issue, i) => (
            <li
              key={`${issue.code}-${issue.path}-${i}`}
              className={`rounded-lg border px-3 py-2 text-xs ${
                issue.severity === 'error'
                  ? 'border-coral/30 bg-coral/10 text-coral'
                  : 'border-honey/30 bg-honey/10 text-honey'
              }`}
            >
              <span className="font-mono opacity-70">{issue.path}</span>
              <p className="mt-0.5 text-ink-soft">{issue.message}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Metric({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-lg bg-night-2 px-3 py-2">
      <dt className="text-ink-faint">{label}</dt>
      <dd className={`mt-0.5 font-semibold ${warn ? 'text-honey' : 'text-ink'}`}>{value}</dd>
    </div>
  )
}
