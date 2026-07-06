'use client'

/**
 * Governed Flow Builder — governance-panel (WP-4 Simulation, WP-5 Diff, WP-6 Pack).
 * Izolált, önálló komponens: saját állapot + hibakezelés, nem nyúl a szerkesztőhöz.
 * A determinisztikus munkát a szerveroldali action-ök végzik (simulate/diff/export).
 */
import { useEffect, useState, useTransition } from 'react'
import {
  simulatePlaybookVersionV2,
  diffPlaybookVersionsV2,
  exportPlaybookPackV2,
} from '@/app/actions/playbook'
import { listProcessDefinitions } from '@/app/actions/process'

type VersionRef = { id: string; version: number; status: string }

type ProcessDefinitionRef = { id: string; name: string; playbookVersionId: string }

type SimReport = {
  findings: Array<{ category: string; severity: string; stepId?: string; gateId?: string; message: string }>
  expectedPath: string[]
  encounteredGates: string[]
  estimatedCostEur: number
  estimatedDurationMinutes: number
}

type DiffResult = {
  diff: {
    changes: Array<{ kind: string; category: string; id: string; risk: string; detail: string }>
    highestRisk: string
    counts: Record<string, number>
  }
  base: { version: number; contentHash: string }
  target: { version: number; contentHash: string }
}

const SEVERITY_TONE: Record<string, string> = {
  error: 'bg-coral/15 text-coral',
  warning: 'bg-honey/15 text-honey',
  info: 'bg-sky-500/15 text-sky-300',
}
const RISK_TONE: Record<string, string> = {
  high: 'bg-coral/15 text-coral',
  medium: 'bg-honey/15 text-honey',
  low: 'bg-ink/8 text-ink-soft',
  none: 'bg-sage/15 text-sage',
}

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>{children}</span>
}

export function PlaybookGovernancePanel({
  playbookId,
  versions,
}: {
  playbookId: string
  versions: VersionRef[]
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [simVersionId, setSimVersionId] = useState(versions[0]?.id ?? '')
  const [sim, setSim] = useState<SimReport | null>(null)
  const [processDefinitions, setProcessDefinitions] = useState<ProcessDefinitionRef[]>([])
  const [simProcessDefinitionId, setSimProcessDefinitionId] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    listProcessDefinitions({}).then((res) => {
      if (!cancelled && res.success) {
        setProcessDefinitions(res.data as ProcessDefinitionRef[])
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const [baseId, setBaseId] = useState(versions[1]?.id ?? versions[0]?.id ?? '')
  const [targetId, setTargetId] = useState(versions[0]?.id ?? '')
  const [diff, setDiff] = useState<DiffResult | null>(null)

  const [packHash, setPackHash] = useState<string | null>(null)

  if (versions.length === 0) return null

  function runSim() {
    setError(null)
    startTransition(async () => {
      const res = await simulatePlaybookVersionV2({
        playbookVersionId: simVersionId,
        ...(simProcessDefinitionId ? { processDefinitionId: simProcessDefinitionId } : {}),
      })
      if (res.success) setSim(res.data as SimReport)
      else setError(res.error)
    })
  }
  function runDiff() {
    setError(null)
    startTransition(async () => {
      const res = await diffPlaybookVersionsV2({ baseVersionId: baseId, targetVersionId: targetId })
      if (res.success) setDiff(res.data as DiffResult)
      else setError(res.error)
    })
  }
  function runExport() {
    setError(null)
    startTransition(async () => {
      const res = await exportPlaybookPackV2({ id: playbookId })
      if (!res.success) {
        setError(res.error)
        return
      }
      const pack = res.data as { contentHash: string }
      setPackHash(pack.contentHash)
      try {
        const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `playbook-pack-${playbookId}.json`
        a.click()
        URL.revokeObjectURL(url)
      } catch {
        // A hash így is látszik; a letöltés best-effort (SSR/headless env).
      }
    })
  }

  const versionLabel = (v: VersionRef) => `v${v.version} (${v.status})`

  return (
    <section className="space-y-4 rounded-xl border border-ink/10 bg-paper/40 p-4">
      <h3 className="text-sm font-semibold text-ink">Governance eszközök</h3>
      {error && <p className="text-xs text-coral">{error}</p>}

      {/* WP-4 Szimuláció */}
      <div className="space-y-2 rounded-lg border border-ink/10 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-ink-soft">Szimbolikus szimuláció</span>
          <select
            value={simVersionId}
            onChange={(e) => {
              setSimVersionId(e.target.value)
              setSimProcessDefinitionId('')
            }}
            className="rounded border border-ink/15 bg-transparent px-2 py-1 text-xs"
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {versionLabel(v)}
              </option>
            ))}
          </select>
          <select
            value={simProcessDefinitionId}
            onChange={(e) => setSimProcessDefinitionId(e.target.value)}
            className="rounded border border-ink/15 bg-transparent px-2 py-1 text-xs"
            title="Ha kiválasztasz egy Folyamatot, a szimuláció annak roleBindings-eit használja a hiányzó-role/capability ellenőrzéshez."
          >
            <option value="">Kötések nélkül (üres roleBindings)</option>
            {processDefinitions
              .filter((p) => p.playbookVersionId === simVersionId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  Folyamat: {p.name}
                </option>
              ))}
          </select>
          <button
            onClick={runSim}
            disabled={pending || !simVersionId}
            className="rounded-lg border border-ink/20 px-3 py-1 text-xs disabled:opacity-50"
          >
            Szimuláció (dry-run)
          </button>
        </div>
        {sim && (
          <div className="space-y-2 text-xs">
            <p className="text-ink-soft">
              Várt út: <span className="font-mono text-ink">{sim.expectedPath.join(' → ') || '—'}</span>
              {' · '}Becsült költség: <span className="font-mono">{sim.estimatedCostEur} €</span>
              {' · '}~{sim.estimatedDurationMinutes} perc
            </p>
            {sim.findings.length === 0 ? (
              <p className="text-sage">Nincs feltárt hiányosság.</p>
            ) : (
              <ul className="space-y-1">
                {sim.findings.map((f, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <Chip tone={SEVERITY_TONE[f.severity] ?? 'bg-ink/8 text-ink-soft'}>{f.category}</Chip>
                    <span className="text-ink-soft">{f.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* WP-5 Diff */}
      {versions.length >= 2 && (
        <div className="space-y-2 rounded-lg border border-ink/10 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-ink-soft">Risk-weighted diff</span>
            <select
              value={baseId}
              onChange={(e) => setBaseId(e.target.value)}
              className="rounded border border-ink/15 bg-transparent px-2 py-1 text-xs"
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {versionLabel(v)}
                </option>
              ))}
            </select>
            <span className="text-ink-soft">→</span>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="rounded border border-ink/15 bg-transparent px-2 py-1 text-xs"
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {versionLabel(v)}
                </option>
              ))}
            </select>
            <button
              onClick={runDiff}
              disabled={pending || baseId === targetId}
              className="rounded-lg border border-ink/20 px-3 py-1 text-xs disabled:opacity-50"
            >
              Összehasonlítás
            </button>
          </div>
          {diff && (
            <div className="space-y-1 text-xs">
              <p className="text-ink-soft">
                Legmagasabb kockázat: <Chip tone={RISK_TONE[diff.diff.highestRisk] ?? RISK_TONE.none}>{diff.diff.highestRisk}</Chip>
                {' · '}high: {diff.diff.counts.high ?? 0} · medium: {diff.diff.counts.medium ?? 0} · low: {diff.diff.counts.low ?? 0}
              </p>
              {diff.diff.changes.length === 0 ? (
                <p className="text-sage">Nincs érdemi (spec-szintű) változás.</p>
              ) : (
                <ul className="space-y-1">
                  {diff.diff.changes.map((c, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <Chip tone={RISK_TONE[c.risk] ?? RISK_TONE.none}>{c.risk}</Chip>
                      <span className="text-ink-soft">
                        [{c.kind}/{c.category}] {c.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* WP-6 Pack export */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-ink/10 p-3">
        <span className="text-xs font-medium text-ink-soft">Playbook Pack (csak template)</span>
        <button
          onClick={runExport}
          disabled={pending}
          className="rounded-lg border border-ink/20 px-3 py-1 text-xs disabled:opacity-50"
        >
          Pack export letöltése
        </button>
        {packHash && <span className="font-mono text-[11px] text-ink-soft">{packHash.slice(0, 24)}…</span>}
      </div>
    </section>
  )
}
