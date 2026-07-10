'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import {
  approveMemoryCandidate,
  getAgentMemoryOverview,
  listAgentMemoryProjectKeys,
  rejectMemoryCandidate,
  rollbackMemoryVersion,
  runMemoryMaintenance,
} from '@/app/actions/platform'
import type { AgentDetailMemoryOverview } from '@/lib/agent-detail-page-data'

type ChunkRow = {
  id: string
  type: string
  title: string
  summary: string | null
  text: string
  salience: number
  updatedAt: string | Date
}

type CandidateRow = {
  id: string
  operation: string
  proposedBy: string
  status: string
  payload: unknown
}

type VersionRow = {
  id: string
  version: number
  createdAt: string | Date
  changeSet: unknown
  activeChunkIds: unknown
}

type Overview = AgentDetailMemoryOverview

function fmtDate(d: string | Date) {
  return new Date(d).toLocaleString('hu-HU')
}

function candidateSummary(c: CandidateRow): string {
  const p = c.payload as { title?: string; summary?: string; reason?: string; supersedes?: string } | null
  return p?.title ?? p?.summary ?? p?.reason ?? `${c.operation} → ${p?.supersedes ?? '?'}`
}

function projectKeyLabel(key: string): string {
  if (key === '__general__') return 'Általános (alapértelmezett)'
  return key
}

function ChunkList({ title, chunks }: { title: string; chunks: ChunkRow[] }) {
  if (chunks.length === 0) return null
  return (
    <div className="mt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{title}</p>
      <ul className="mt-1 space-y-1.5">
        {chunks.map((c) => (
          <li key={c.id} className="atelier-soft p-2.5 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-ink">{c.title}</span>
              <span className="text-xs text-ink-faint">salience {c.salience.toFixed(2)}</span>
            </div>
            {c.summary && <p className="mt-0.5 text-xs text-ink-soft">{c.summary}</p>}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function MemoryPanel({
  agentId,
  initialProjectKeys,
  initialProjectKey = '__general__',
  initialOverview,
}: {
  agentId: string
  initialProjectKeys?: string[]
  initialProjectKey?: string
  initialOverview?: Overview | null
}) {
  const [projectKey, setProjectKey] = useState(initialProjectKey)
  const [projectKeys, setProjectKeys] = useState<string[]>(initialProjectKeys ?? ['__general__'])
  const [overview, setOverview] = useState<Overview | null>(initialOverview ?? null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const skipInitialOverviewLoad = useRef(Boolean(initialOverview))

  function loadOverview() {
    startTransition(async () => {
      setError(null)
      const res = await getAgentMemoryOverview({ agentId, projectKey })
      if (res.success) setOverview(res.data as Overview)
      else setError(res.error ?? 'Ismeretlen hiba')
    })
  }

  function loadProjectKeys() {
    startTransition(async () => {
      const res = await listAgentMemoryProjectKeys({ agentId })
      if (res.success && Array.isArray((res.data as { projectKeys?: string[] }).projectKeys)) {
        const keys = (res.data as { projectKeys: string[] }).projectKeys
        setProjectKeys(keys)
        setProjectKey((current) => (keys.includes(current) ? current : keys[0] ?? '__general__'))
      }
    })
  }

  useEffect(() => {
    if (initialProjectKeys) return
    loadProjectKeys()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, initialProjectKeys])

  useEffect(() => {
    if (skipInitialOverviewLoad.current) {
      skipInitialOverviewLoad.current = false
      return
    }
    loadOverview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, projectKey])

  function run(fn: () => Promise<{ success: boolean; error?: string }>) {
    startTransition(async () => {
      setError(null)
      setNotice(null)
      const res = await fn()
      if (res.success) loadOverview()
      else setError(res.error ?? 'Ismeretlen hiba')
    })
  }

  function runMaintenance() {
    startTransition(async () => {
      setError(null)
      setNotice(null)
      const res = await runMemoryMaintenance({ agentId, projectKey })
      if (!res.success) {
        setError(res.error ?? 'Ismeretlen hiba')
        return
      }
      const data = (res.data ?? {}) as {
        proposedCandidateIds?: string[]
        scannedChunkCount?: number
        skippedByBudget?: number
      }
      const proposed = Array.isArray(data.proposedCandidateIds) ? data.proposedCandidateIds.length : 0
      const scanned = typeof data.scannedChunkCount === 'number' ? data.scannedChunkCount : 0
      const skipped = typeof data.skippedByBudget === 'number' ? data.skippedByBudget : 0
      setNotice(
        proposed > 0
          ? `Karbantartás kész: ${proposed} javaslat készült (${scanned} emlék átnézve${
              skipped > 0 ? `, ${skipped} token budget miatt kihagyva` : ''
            }).`
          : `Karbantartás kész: nem talált javasolható módosítást (${scanned} emlék átnézve).`,
      )
      loadOverview()
    })
  }

  const state = overview?.projectState

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-ink-soft" htmlFor="memory-project-key">
          Projekt
        </label>
        <select
          id="memory-project-key"
          value={projectKey}
          disabled={pending || projectKeys.length === 0}
          onChange={(e) => setProjectKey(e.target.value)}
          className="rounded-lg border border-line bg-card px-3 py-1.5 text-sm"
        >
          {projectKeys.map((key) => (
            <option key={key} value={key}>
              {projectKeyLabel(key)}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={pending}
          onClick={loadOverview}
          className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft hover:bg-line/30"
        >
          Frissítés
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={runMaintenance}
          className="rounded-full bg-sky/20 px-3 py-1.5 text-xs font-semibold text-sky hover:bg-sky/30"
        >
          Memória karbantartás indítása
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-ink-faint">
        A projekt határozza meg, mely beszélgetések és emlékek tartoznak együtt. Az általános
        szálak alapértelmezése a <code className="rounded bg-night-2 px-1">__general__</code>.
      </p>

      {error && <p className="text-xs text-coral">{error}</p>}
      {notice && <p className="text-xs text-sage">{notice}</p>}
      {!overview && !error && !initialOverview && (
        <p className="text-sm text-ink-faint">Betöltés…</p>
      )}

      {state && (
        <div className="atelier-soft p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Jelenlegi fókusz (project_state)
          </p>
          {state.focus ? (
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink-soft">{state.focus.text}</p>
          ) : (
            <p className="mt-1 text-sm italic text-ink-faint">Nincs aktív fókusz-emlék.</p>
          )}
          <ChunkList title="Döntések" chunks={state.decisions} />
          <ChunkList title="Nyitott feladatok" chunks={state.openTasks} />
          <ChunkList title="Megkötések" chunks={state.constraints} />
          <ChunkList title="Kulcs artifaktok" chunks={state.artifacts} />
        </div>
      )}

      {overview && overview.activeChunks.length > 0 && (
        <div className="atelier-soft p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Aktív emlékek ({overview.activeChunks.length})
          </p>
          <ul className="mt-2 space-y-1.5">
            {overview.activeChunks.map((c) => (
              <li key={c.id} className="rounded-lg border border-line/60 bg-card/40 p-2.5 text-sm text-ink-soft">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium text-ink">[{c.type}]</span>
                  <span className="text-ink">{c.title}</span>
                  <span className="ml-auto text-xs text-ink-faint">{fmtDate(c.updatedAt)}</span>
                </div>
                {c.summary && <p className="mt-1 text-xs text-ink-faint">{c.summary}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {overview && overview.candidateQueue.length > 0 && (
        <div className="atelier-soft p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Függő javaslatok ({overview.candidateQueue.length})
          </p>
          <ul className="mt-2 space-y-2">
            {overview.candidateQueue.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-ink-soft">
                  <span className="font-medium text-ink">{c.operation}</span> — {candidateSummary(c)}
                  <span className="ml-2 text-xs text-ink-faint">({c.status})</span>
                </span>
                {(c.status === 'proposed' || c.status === 'modified') && (
                  <span className="flex gap-2">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(() => approveMemoryCandidate({ candidateId: c.id }))}
                      className="rounded-full bg-sage/20 px-3 py-1 text-xs font-semibold text-sage hover:bg-sage/30"
                    >
                      Jóváhagyom
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(() => rejectMemoryCandidate({ candidateId: c.id }))}
                      className="rounded-full border border-coral/30 px-3 py-1 text-xs font-semibold text-coral hover:bg-coral/10"
                    >
                      Elvetem
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {overview && overview.maintenanceProposals.length > 0 && (
        <div className="atelier-soft p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Karbantartási javaslatok ({overview.maintenanceProposals.length})
          </p>
          <ul className="mt-2 space-y-2">
            {overview.maintenanceProposals.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-ink-soft">
                  <span className="font-medium text-ink">{c.operation}</span> — {candidateSummary(c)}
                  <span className="ml-2 text-xs text-ink-faint">({c.status})</span>
                </span>
                {(c.status === 'proposed' || c.status === 'modified') && (
                  <span className="flex gap-2">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(() => approveMemoryCandidate({ candidateId: c.id }))}
                      className="rounded-full bg-sage/20 px-3 py-1 text-xs font-semibold text-sage hover:bg-sage/30"
                    >
                      Jóváhagyom
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(() => rejectMemoryCandidate({ candidateId: c.id }))}
                      className="rounded-full border border-coral/30 px-3 py-1 text-xs font-semibold text-coral hover:bg-coral/10"
                    >
                      Elvetem
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {overview && overview.versions.length > 0 && (
        <div className="atelier-soft p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Verzió-idővonal
          </p>
          <ul className="mt-2 space-y-1.5">
            {overview.versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-ink-soft">
                  v{v.version} — {fmtDate(v.createdAt)}
                </span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (!confirm(`Biztosan visszaállítod a memóriát a(z) v${v.version} állapotra?`)) return
                    run(() => rollbackMemoryVersion({ agentId, projectKey, toVersion: v.version }))
                  }}
                  className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:bg-line/30"
                >
                  Vissza erre
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
