'use client'

import { useEffect, useMemo, useState } from 'react'
import { getKbArtifactReview } from '@/app/actions/platform'

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
 * §12.2 hárompaneles OKF artifact-review overlay:
 *  (1) forrás / extracted text,
 *  (2) generált OKF file-tree + oldal-preview,
 *  (3) §7.6 validation report + approve/reject.
 */
export function KbArtifactReview({
  agentId,
  documentId,
  canApprove,
  actionPending,
  onApprove,
  onReject,
  onClose,
}: {
  agentId: string
  documentId: string
  canApprove: boolean
  actionPending: boolean
  onApprove: (ticketId: string) => void
  onReject: (ticketId: string) => void
  onClose: () => void
}) {
  const [data, setData] = useState<ReviewData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

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

  const selectedFile = useMemo(
    () => data?.files.find((f) => f.path === selectedPath) ?? null,
    [data, selectedPath],
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-line bg-night shadow-xl">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-widest text-ink-faint">
              OKF artifact-review
            </p>
            <h2 className="truncate font-display text-lg font-semibold text-ink" title={data?.filename}>
              {data?.filename ?? 'Betöltés…'}
              {data?.artifact ? (
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
        </header>

        {error ? (
          <div className="p-6 text-sm text-coral">{error}</div>
        ) : !data ? (
          <div className="p-6 text-sm text-ink-faint">Review betöltése…</div>
        ) : data.processingMode !== 'okf' && data.files.length === 0 ? (
          <div className="p-6 text-sm text-ink-soft">
            Ez a dokumentum <span className="font-medium text-ink">nyers szöveg</span> módban készült —
            nincs OKF-artifact review. A jóváhagyás közvetlenül a nyers szöveget teszi kereshetővé.
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-px overflow-hidden bg-line lg:grid-cols-3">
            {/* 1. Forrás / extracted text */}
            <section className="flex min-h-0 flex-col overflow-hidden bg-night">
              <h3 className="border-b border-line px-4 py-2 text-xs font-semibold uppercase tracking-widest text-ink-faint">
                Forrás (extracted)
              </h3>
              <pre className="flex-1 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-relaxed text-ink-soft">
                {data.extractedText?.trim() || '(nincs kinyert szöveg)'}
              </pre>
            </section>

            {/* 2. OKF file-tree + preview */}
            <section className="flex min-h-0 flex-col overflow-hidden bg-night">
              <h3 className="border-b border-line px-4 py-2 text-xs font-semibold uppercase tracking-widest text-ink-faint">
                Generált OKF ({data.files.length})
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
                Validáció (§7.6)
              </h3>
              <div className="flex-1 overflow-auto px-4 py-3">
                {data.validation ? (
                  <ValidationReport validation={data.validation} />
                ) : (
                  <p className="text-sm text-ink-faint">Nincs validációs adat.</p>
                )}
              </div>
              {canApprove && data.ticketId ? (
                <div className="flex gap-2 border-t border-line px-4 py-3">
                  <button
                    type="button"
                    disabled={actionPending}
                    onClick={() => onApprove(data.ticketId as string)}
                    className="flex-1 rounded-full bg-sage/20 px-3 py-2 text-sm font-semibold text-sage hover:bg-sage/30 disabled:opacity-50"
                  >
                    Jóváhagyás &amp; publikálás
                  </button>
                  <button
                    type="button"
                    disabled={actionPending}
                    onClick={() => onReject(data.ticketId as string)}
                    className="flex-1 rounded-full bg-coral/20 px-3 py-2 text-sm font-semibold text-coral hover:bg-coral/30 disabled:opacity-50"
                  >
                    Elutasítás
                  </button>
                </div>
              ) : !canApprove ? (
                <p className="border-t border-line px-4 py-3 text-xs text-ink-faint">
                  A jóváhagyáshoz approver jogosultság szükséges.
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
