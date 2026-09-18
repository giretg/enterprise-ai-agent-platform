'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import {
  approvePromotion,
  createDataSnapshot,
  requestPromotion,
  requestSandboxExport,
} from '@/app/actions/sandbox-versioning'

type PendingPromotion = { promotionId: string; fromCommitId: string; requestedByLabel: string }
type CommitRef = { commitId: string; seq: number; isTest: boolean }
type SnapshotRef = { snapshotId: string; env: string; kind: string; schemaHash: string }

export function SandboxProjectPanel({
  projectId,
  pending,
  commits,
  snapshots,
  liveCommitId,
}: {
  projectId: string
  pending: PendingPromotion[]
  commits: CommitRef[]
  snapshots: SnapshotRef[]
  liveCommitId?: string
}) {
  const router = useRouter()
  const [busy, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [scope, setScope] = useState<'code_only' | 'code_and_schema' | 'full'>('full')
  const [snapshotId, setSnapshotId] = useState<string>(snapshots.find((s) => s.env === 'live')?.snapshotId ?? '')
  const [transfer, setTransfer] = useState(false)

  const run = (fn: () => Promise<{ success: boolean; error?: string; data?: unknown }>, okMsg?: string) => {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.success) {
        setError(res.error ?? 'Ismeretlen hiba')
        return
      }
      if (okMsg) setNotice(okMsg)
      router.refresh()
    })
  }

  const hasTest = commits.some((c) => c.isTest)

  return (
    <Card title="Műveletek">
      {error && (
        <p className="mb-3 rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">{error}</p>
      )}
      {notice && (
        <p className="mb-3 rounded-lg border border-sage/30 bg-sage/10 px-4 py-2 text-sm text-sage">{notice}</p>
      )}

      {/* Promóció-kérés */}
      <div className="space-y-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Promóció (go-live)</h3>
          <p className="mt-1 text-xs text-ink-faint">
            A promóció a <strong>test</strong> commitot élesíti. A jóváhagyás előbb automatikus
            mentést készít a <strong>live</strong> adatról — a go-live emberi döntés (kemény padló).
          </p>
          <button
            type="button"
            disabled={busy || !hasTest}
            onClick={() => run(() => requestPromotion({ projectId }), 'Promóció kérve — emberi jóváhagyásra vár.')}
            className="mt-2 rounded-full bg-sage/20 px-4 py-2 text-sm font-semibold text-sage hover:bg-sage/30 disabled:opacity-50"
          >
            Promóció kérése (test → live)
          </button>
        </div>

        {pending.length > 0 && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Jóváhagyásra vár ({pending.length})
            </h4>
            <ul className="mt-2 space-y-2">
              {pending.map((p) => (
                <li key={p.promotionId} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono text-[11px] text-ink-faint">
                    {p.fromCommitId.slice(0, 8)} · kérte: {p.requestedByLabel}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => approvePromotion({ promotionId: p.promotionId, decision: 'approve' }),
                        'Élesítve (live commit frissült, pre-promotion snapshot elkészült).',
                      )
                    }
                    className="rounded-full bg-sage/20 px-3 py-1 text-xs font-semibold text-sage hover:bg-sage/30 disabled:opacity-50"
                  >
                    Jóváhagyás
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      run(() => approvePromotion({ promotionId: p.promotionId, decision: 'reject' }), 'Elutasítva.')
                    }
                    className="rounded-full bg-coral/20 px-3 py-1 text-xs font-semibold text-coral hover:bg-coral/30 disabled:opacity-50"
                  >
                    Elutasítás
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Snapshot */}
        <div className="border-t border-line pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Adat-snapshot</h3>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => createDataSnapshot({ projectId, env: 'test' }), 'Test snapshot kész.')}
              className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft hover:border-sage/50 hover:text-ink disabled:opacity-50"
            >
              Test snapshot
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => createDataSnapshot({ projectId, env: 'live' }), 'Live snapshot kész.')}
              className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft hover:border-sage/50 hover:text-ink disabled:opacity-50"
            >
              Live snapshot
            </button>
          </div>
        </div>

        {/* Graduation / export */}
        <div className="border-t border-line pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Graduation / export</h3>
          <p className="mt-1 text-xs text-ink-faint">
            A modult a saját környezetedbe kiszervezhető csomagba (kód + séma + adat) csomagolja. A
            letöltés után a scratchpad-felelősség átszáll. Reprodukálható checksum.
          </p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="text-xs text-ink-soft">
              Scope
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as typeof scope)}
                className="ml-2 rounded-lg border border-line bg-night-2 px-2 py-1 text-sm text-ink focus:border-sage/50 focus:outline-none"
              >
                <option value="code_only">code_only</option>
                <option value="code_and_schema">code_and_schema</option>
                <option value="full">full</option>
              </select>
            </label>
            {scope === 'full' && (
              <label className="text-xs text-ink-soft">
                Snapshot
                <select
                  value={snapshotId}
                  onChange={(e) => setSnapshotId(e.target.value)}
                  className="ml-2 rounded-lg border border-line bg-night-2 px-2 py-1 text-sm text-ink focus:border-sage/50 focus:outline-none"
                >
                  <option value="">— válassz —</option>
                  {snapshots.map((s) => (
                    <option key={s.snapshotId} value={s.snapshotId}>
                      {s.env}/{s.kind} · {s.schemaHash.replace('sha256:', '').slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex items-center gap-1 text-xs text-ink-soft">
              <input type="checkbox" checked={transfer} onChange={(e) => setTransfer(e.target.checked)} />
              felelősség-átadás (admin)
            </label>
            <button
              type="button"
              disabled={busy || !liveCommitId}
              onClick={() =>
                run(async () => {
                  const res = await requestSandboxExport({
                    projectId,
                    scope,
                    sourceSnapshotId: scope === 'full' ? snapshotId || undefined : undefined,
                    markResponsibilityTransfer: transfer,
                  })
                  if (res.success) {
                    setNotice(`Export kész — checksum: ${res.data.packageHash}`)
                  }
                  return res
                })
              }
              className="rounded-full bg-coral/20 px-4 py-2 text-sm font-semibold text-coral hover:bg-coral/30 disabled:opacity-50"
            >
              Export indítása
            </button>
          </div>
          {!liveCommitId && (
            <p className="mt-1 text-[11px] text-ink-faint">Előbb élesíts egy commitot (promóció).</p>
          )}
        </div>
      </div>
    </Card>
  )
}
