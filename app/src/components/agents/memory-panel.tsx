'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, useTransition } from 'react'
import {
  approveMemoryCandidate,
  getAgentMemoryOverview,
  listAgentMemoryProjectKeys,
  rejectMemoryCandidate,
  rollbackMemoryVersion,
  runMemoryMaintenance,
} from '@/app/actions/platform'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import type { AgentDetailMemoryOverview } from '@/lib/agent-detail-page-data'
import {
  extraMemoryChunks,
  GENERAL_MEMORY_PROJECT_KEY,
  MEMORY_IMPORTANCE_HINT,
  memoryCandidateStatusLabel,
  memoryImportanceLabel,
  memoryMaintenanceNotice,
  memoryOperationLabel,
  memoryProjectKeyLabel,
  memoryVersionChangeLabel,
} from '@/lib/memory-ui-labels'
import { MEMORY_TYPE_LABELS } from '@/lib/work-traceability'

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
  return p?.title ?? p?.summary ?? p?.reason ?? `${memoryOperationLabel(c.operation)} → ${p?.supersedes ?? '?'}`
}

function ChunkList({
  title,
  hint,
  chunks,
}: {
  title: string
  hint?: string
  chunks: ChunkRow[]
}) {
  if (chunks.length === 0) return null
  return (
    <div className="mt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{title}</p>
      {hint ? <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{hint}</p> : null}
      <ul className="mt-1 space-y-1.5">
        {chunks.map((c) => {
          const importance = memoryImportanceLabel(c.salience)
          return (
            <li key={c.id} className="atelier-soft p-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-ink">{c.title}</span>
                {importance ? (
                  <span className="text-xs text-ink-faint" title={MEMORY_IMPORTANCE_HINT}>
                    {importance}
                  </span>
                ) : null}
              </div>
              {c.summary && <p className="mt-0.5 text-xs text-ink-soft">{c.summary}</p>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function CandidateList({
  title,
  hint,
  items,
  pending,
  onApprove,
  onReject,
}: {
  title: string
  hint: string
  items: CandidateRow[]
  pending: boolean
  onApprove: (id: string) => void
  onReject: (id: string) => void
}) {
  return (
    <div className="atelier-soft p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
        {title} ({items.length})
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">{hint}</p>
      <ul className="mt-2 space-y-2">
        {items.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-ink-soft">
              <span className="font-medium text-ink">{memoryOperationLabel(c.operation)}</span>
              {' — '}
              {candidateSummary(c)}
              <span className="ml-2 text-xs text-ink-faint">
                ({memoryCandidateStatusLabel(c.status)})
              </span>
            </span>
            {(c.status === 'proposed' || c.status === 'modified') && (
              <span className="flex gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => onApprove(c.id)}
                  className="rounded-full bg-sage/20 px-3 py-1 text-xs font-semibold text-sage hover:bg-sage/30"
                >
                  Jóváhagyom
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => onReject(c.id)}
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
  )
}

export function MemoryPanel({
  agentId,
  initialProjectKeys,
  initialProjectKey = GENERAL_MEMORY_PROJECT_KEY,
  initialProjectLabels,
  initialOverview,
}: {
  agentId: string
  initialProjectKeys?: string[]
  initialProjectKey?: string
  initialProjectLabels?: Record<string, string>
  initialOverview?: Overview | null
}) {
  const [projectKey, setProjectKey] = useState(initialProjectKey)
  const [projectKeys, setProjectKeys] = useState<string[]>(
    initialProjectKeys ?? [GENERAL_MEMORY_PROJECT_KEY],
  )
  const [projectLabels, setProjectLabels] = useState<Record<string, string>>(
    initialProjectLabels ?? {},
  )
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
        const data = res.data as { projectKeys: string[]; labels?: Record<string, string> }
        const keys = data.projectKeys
        setProjectKeys(keys)
        if (data.labels) setProjectLabels(data.labels)
        setProjectKey((current) => (keys.includes(current) ? current : keys[0] ?? GENERAL_MEMORY_PROJECT_KEY))
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
      setNotice(memoryMaintenanceNotice({ proposed, scanned, skipped }))
      loadOverview()
    })
  }

  const state = overview?.projectState
  const extraChunks =
    overview && state
      ? extraMemoryChunks(overview.activeChunks, [
          state.focus,
          ...state.decisions,
          ...state.openTasks,
          ...state.constraints,
          ...state.artifacts,
        ])
      : []

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-ink-soft">
        A projekt egy nagyobb, összefüggő munka: több beszélgetés és több AI-munkatárs
        tartozhat hozzá. Itt azt látod, amit ez az agent erről a projektről a beszélgetések
        között is megjegyez — hol tartunk, mit döntöttünk, mi van még hátra.
      </p>
      <p className="text-[13px] leading-relaxed text-ink-soft">
        A viselkedési szabályok a Tanulás fülön vannak, a céges dokumentumok a Tudásbázisban.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-ink-soft" htmlFor="memory-project-key">
          Melyik projekt emlékeit nézed
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
              {memoryProjectKeyLabel(key, projectLabels)}
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
          title="Átnézi az emlékeket, és javaslatot tesz, ha valami elavult, ellentmondásos vagy háttérbe szorult. Magától semmit nem töröl és nem módosít."
          className="rounded-full bg-sky/20 px-3 py-1.5 text-xs font-semibold text-sky hover:bg-sky/30"
        >
          Emlékek átnézése
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-ink-faint">
        Az Általánosba kerül, amihez nincs külön projekt rendelve. Új projektet a{' '}
        <Link
          href="/control-plane/projects"
          className="font-medium text-ink-soft underline underline-offset-2 hover:text-ink"
        >
          Projektek
        </Link>{' '}
        menüben hozhatsz létre.
      </p>
      <p className="text-[11px] leading-relaxed text-ink-faint">
        Az átnézés csak javaslatot készít (elavult, ellentmondásos vagy rég nem használt
        emlékekre). Jóváhagyás nélkül semmi nem változik.
      </p>

      {error && <p className="text-xs text-coral">{error}</p>}
      {notice && <p className="text-xs text-sage">{notice}</p>}
      {!overview && !error && !initialOverview && (
        <p className="text-sm text-ink-faint">Betöltés…</p>
      )}

      {state && (
        <div className="atelier-soft p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Hol tartunk most
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
            Rövid, jóváhagyott összefoglaló: hol áll a munka, és mi a következő lépés. Az
            agent ezt minden új beszélgetés elején látja.
          </p>
          {state.focus ? (
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink-soft">{state.focus.text}</p>
          ) : (
            <p className="mt-2 text-sm italic text-ink-faint">
              Még nincs feljegyezve, hol tart a munka. Ez nem hiba — akkor kerül ide szöveg, ha
              az agent egy beszélgetés vagy feladat után javasol egy rövid „hol tartunk”
              összefoglalót, és te jóváhagyod.
            </p>
          )}
          <ChunkList
            title="Döntések"
            hint="Amit ebben a munkában már eldöntöttünk, és később is érvényes."
            chunks={state.decisions}
          />
          <ChunkList
            title="Nyitott feladatok"
            hint="Ami még hátra van ebből a munkából."
            chunks={state.openTasks}
          />
          <ChunkList
            title="Projekt-szabályok"
            hint="Korlátok, amiket ebben a munkában mindig be kell tartani (kötelező lépés, tiltott eljárás). A hangnem, köszönés, stílus nem ide tartozik — azt a Tanulás fülön tanítsd."
            chunks={state.constraints}
          />
          <ChunkList
            title="Fontos fájlok"
            hint="Kulcsdokumentum, fájl, branch vagy hivatkozás, amit a munkához érdemes kéznél tartani."
            chunks={state.artifacts}
          />
        </div>
      )}

      {extraChunks.length > 0 && (
        <div className="atelier-soft p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            További emlékek ({extraChunks.length})
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
            Tanulságok, feltételezések, sikertelen próbálkozások, átadások — amik nem férnek
            a fenti összefoglalóba, de az agent továbbra is használhatja őket.
          </p>
          <ul className="mt-2 space-y-1.5">
            {extraChunks.map((c) => (
              <li key={c.id} className="rounded-lg border border-line/60 bg-card/40 p-2.5 text-sm text-ink-soft">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium text-ink">
                    {MEMORY_TYPE_LABELS[c.type] ?? c.type}
                  </span>
                  <span className="text-ink">{c.title}</span>
                  <span className="ml-auto text-xs text-ink-faint">Frissítve: {fmtDate(c.updatedAt)}</span>
                </div>
                {c.summary && <p className="mt-1 text-xs text-ink-faint">{c.summary}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {overview && overview.candidateQueue.length > 0 && (
        <CandidateList
          title="Függő javaslatok"
          hint="Az agent beszélgetés közben javasolta ezeket. Jóváhagyásig nem kerülnek be az emlékezetbe."
          items={overview.candidateQueue}
          pending={pending}
          onApprove={(id) => run(() => approveMemoryCandidate({ candidateId: id }))}
          onReject={(id) => run(() => rejectMemoryCandidate({ candidateId: id }))}
        />
      )}

      {overview && overview.maintenanceProposals.length > 0 && (
        <CandidateList
          title="Átnézési javaslatok"
          hint="Az átnézés találta ezeket (elavult, ellentmondásos vagy háttérbe szorult emlék). Jóváhagyásig semmi nem változik."
          items={overview.maintenanceProposals}
          pending={pending}
          onApprove={(id) => run(() => approveMemoryCandidate({ candidateId: id }))}
          onReject={(id) => run(() => rejectMemoryCandidate({ candidateId: id }))}
        />
      )}

      {overview && overview.versions.length > 0 && (
        <div className="atelier-soft p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Korábbi állapotok
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
            Minden jóváhagyott változás után készül egy pillanatkép arról, mely emlékek voltak
            akkor aktívak. A visszaállítás a mostani listát arra cseréli — a történet megmarad,
            ez is egy új bejegyzést hoz létre.
          </p>
          <ul className="mt-2 space-y-1.5">
            {overview.versions.map((v: VersionRow, index) => {
              const isCurrent = index === 0
              const change = memoryVersionChangeLabel(v.changeSet)
              return (
                <li key={v.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-ink-soft">
                    <span className="font-medium text-ink">{v.version}. állapot</span>
                    {' — '}
                    {fmtDate(v.createdAt)}
                    {change ? <span className="text-ink-faint"> · {change}</span> : null}
                    {isCurrent ? (
                      <span className="ml-2 rounded-full bg-sage/15 px-2 py-0.5 text-[10px] font-semibold text-sage">
                        jelenlegi
                      </span>
                    ) : null}
                  </span>
                  {isCurrent ? (
                    <span className="text-[11px] text-ink-faint">Ez a mostani lista</span>
                  ) : (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        void (async () => {
                          const confirmed = await confirmDialog({
                            title: `Visszaállítás a ${v.version}. állapotra`,
                            description: `A mostani aktív emlékek lecserélődnek arra a listára, ami ekkor volt érvényes: ${fmtDate(v.createdAt)}. A történet megmarad: ez egy új bejegyzést hoz létre, a régi állapotok nem törlődnek.`,
                            confirmLabel: 'Visszaállítás',
                            tone: 'danger',
                          })
                          if (!confirmed) return
                          run(() => rollbackMemoryVersion({ agentId, projectKey, toVersion: v.version }))
                        })()
                      }}
                      className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:bg-line/30"
                    >
                      Visszaállítás erre
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
