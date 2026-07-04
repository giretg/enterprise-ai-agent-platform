import Link from 'next/link'
import { getSandboxProjectDetail, listSandboxProjects } from '@/app/actions/sandbox-versioning'
import { Badge, Card } from '@/components/ui/shell'
import { SandboxProjectPanel } from '@/components/sandbox/sandbox-project-panel'
import { evaluateGraduationReadiness } from '@/lib/sandbox-portability'

export default async function SandboxProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  const [detailRes, listRes] = await Promise.all([
    getSandboxProjectDetail({ projectId }),
    listSandboxProjects(),
  ])

  if (!detailRes.success) {
    return (
      <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
        {detailRes.error}
      </p>
    )
  }

  const project = listRes.success ? listRes.data.find((p) => p.projectId === projectId) : undefined
  const { history, promotions, snapshots } = detailRes.data
  const pending = promotions.filter((p) => p.status === 'pending_approval')
  const readiness = evaluateGraduationReadiness(project?.portability)

  return (
    <div className="space-y-6">
      <div>
        <Link href="/control-plane/sandbox-versions" className="text-xs text-ink-faint hover:text-coral">
          ← Sandbox verziók
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl font-semibold">{project?.name ?? 'Projekt'}</h1>
          <Badge tone={readiness.tone} title={readiness.failingChecks.join(', ') || undefined}>
            {readiness.label}
          </Badge>
        </div>
        {project?.description && <p className="mt-1 text-ink-soft">{project.description}</p>}
        {readiness.status === 'at_risk' && (
          <p className="mt-2 rounded-lg border border-honey/30 bg-honey/10 px-3 py-2 text-xs text-honey">
            ⚠ A hordozhatóság sérült — a graduation-export nem lesz „triviális”, amíg ezek nem rendeződnek:{' '}
            <strong>{readiness.failingChecks.join(', ')}</strong>. A cél a súrlódás-mentes kiszervezés (spec §7.2).
          </p>
        )}
      </div>

      {/* Kód-sín: commit history */}
      <Card title="Commit history (kód-sín)">
        <p className="mb-3 text-xs text-ink-faint">
          A rollback nem törli a history-t: új commitot hoz létre egy korábbi fára. A commit csak a
          <strong> test</strong> fát mozdítja; a <strong>live</strong> csak promócióra változik.
        </p>
        {history.commits.length === 0 ? (
          <p className="text-sm text-ink-faint">Még nincs commit.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-night-1/40">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold text-ink-soft">Seq</th>
                  <th className="px-3 py-2 text-left font-semibold text-ink-soft">Összefoglaló</th>
                  <th className="px-3 py-2 text-left font-semibold text-ink-soft">Forrás</th>
                  <th className="px-3 py-2 text-left font-semibold text-ink-soft">Hash</th>
                  <th className="px-3 py-2 text-left font-semibold text-ink-soft">Env</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {history.commits.map((c) => (
                  <tr key={c.commitId}>
                    <td className="px-3 py-2 tabular-nums text-ink-soft">{c.seq}</td>
                    <td className="px-3 py-2">
                      {c.changeSummary}
                      {c.basedOnCommitId && (
                        <span className="ml-2 text-[11px] text-ink-faint">(rollback)</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={c.createdByLabel === 'agent' ? 'warning' : 'neutral'}>
                        {c.createdByLabel}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-ink-faint">
                      {c.treeHash.replace('sha256:', '').slice(0, 12)}
                    </td>
                    <td className="px-3 py-2">
                      {c.isTest && <Badge tone="warning">test</Badge>}{' '}
                      {c.isLive && <Badge tone="success">live</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Interaktív: promóció / snapshot / export */}
      <SandboxProjectPanel
        projectId={projectId}
        pending={pending}
        commits={history.commits.map((c) => ({ commitId: c.commitId, seq: c.seq, isTest: c.isTest }))}
        snapshots={snapshots}
        liveCommitId={project?.liveCommitId}
      />

      {/* Adat-sín: snapshotok — vizuálisan elkülönítve a kód-history-tól */}
      <Card title="Adat-snapshotok (adat-sín)">
        <p className="mb-3 text-xs text-ink-faint">
          Külön sín a kódtól: az adat-restore soha nem változtat kódot, a kód-rollback soha nem veszi
          el az élő adatot. A séma-hash a kód-fától függetlenül követett.
        </p>
        {snapshots.length === 0 ? (
          <p className="text-sm text-ink-faint">Még nincs snapshot.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-night-1/40">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold text-ink-soft">Env</th>
                  <th className="px-3 py-2 text-left font-semibold text-ink-soft">Típus</th>
                  <th className="px-3 py-2 text-left font-semibold text-ink-soft">Séma-hash</th>
                  <th className="px-3 py-2 text-left font-semibold text-ink-soft">Létrehozva</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {snapshots.map((s) => (
                  <tr key={s.snapshotId}>
                    <td className="px-3 py-2">
                      <Badge tone={s.env === 'live' ? 'success' : 'warning'}>{s.env}</Badge>
                    </td>
                    <td className="px-3 py-2 text-ink-soft">{s.kind}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-ink-faint">
                      {s.schemaHash.replace('sha256:', '').slice(0, 12)}
                    </td>
                    <td className="px-3 py-2 text-xs text-ink-soft">
                      {new Date(s.createdAt).toLocaleString('hu-HU', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Promóció-előzmény */}
      <Card title="Promóció-előzmény">
        {promotions.length === 0 ? (
          <p className="text-sm text-ink-faint">Még nincs promóció.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {promotions.map((p) => (
              <li key={p.promotionId} className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={
                    p.status === 'promoted'
                      ? 'success'
                      : p.status === 'rejected'
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {p.status}
                </Badge>
                <span className="text-ink-soft">kérte: {p.requestedByLabel}</span>
                {p.approvedByUserId && (
                  <span className="text-ink-faint">· jóváhagyó: {p.approvedByUserId.slice(0, 8)}</span>
                )}
                <span className="text-xs text-ink-faint">
                  {new Date(p.requestedAt).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
