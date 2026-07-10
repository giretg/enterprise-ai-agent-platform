import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { listAgents } from '@/app/actions/platform'
import { getMonitor, getMonitorRuns, getMonitorSignals } from '@/app/actions/monitor'
import { MonitorEditorForm, type MonitorFormValues } from '@/components/monitors/monitor-editor-form'
import { MonitorRunLog, type MonitorRunView } from '@/components/monitors/monitor-run-log'
import { DryRunPanel } from '@/components/monitors/dry-run-panel'
import { Card } from '@/components/ui/shell'
import type { Prisma } from '@prisma/client'

const KIND_LABEL: Record<string, string> = {
  board_backlog: 'Board elakadás',
  deadline: 'Határidő',
  connector_count: 'Connector-számlálás',
  composite: 'Összetett',
}

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-300',
  paused: 'bg-yellow-500/15 text-yellow-300',
  revoked: 'bg-red-500/15 text-red-400',
}

function jsonToString(v: Prisma.JsonValue | null): string {
  if (v === null || v === undefined) return '{}'
  return JSON.stringify(v, null, 2)
}

export default async function MonitorDetailPage({
  params,
}: {
  params: Promise<{ monitorId: string }>
}) {
  const { monitorId } = await params
  const [ctx, monitorRes, runsRes, signalsRes, agentsRes] = await Promise.all([
    getAuthContext(),
    getMonitor({ id: monitorId }),
    getMonitorRuns({ id: monitorId, limit: 30 }),
    getMonitorSignals({ id: monitorId }),
    listAgents(),
  ])

  if (!monitorRes.success) notFound()
  const monitor = monitorRes.data

  const canEdit = hasMinimumRole(ctx?.activeTenantRole, 'admin')
  const canRun = hasMinimumRole(ctx?.activeTenantRole, 'operator')

  const agents = agentsRes.success
    ? agentsRes.data.map((a) => ({ id: a.id, name: a.name }))
    : []

  const runs: MonitorRunView[] = runsRes.success
    ? runsRes.data.map((r) => ({
        id: r.id,
        outcome: r.outcome,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        scheduledFor: r.scheduledFor.toISOString(),
        signalCount: r.signalCount,
        matchedCount: r.matchedCount,
        suppressedCount: r.suppressedCount,
        openedTicketIds: r.openedTicketIds,
        llmInvoked: r.llmInvoked,
        costUsd: r.costUsd?.toString() ?? null,
        error: r.error,
      }))
    : []

  const signals = signalsRes.success ? signalsRes.data : []

  const formValues: Partial<MonitorFormValues> = {
    id: monitor.id,
    kind: monitor.kind,
    title: monitor.title,
    description: monitor.description ?? '',
    intervalSeconds: monitor.intervalSeconds,
    collectorConfig: jsonToString(monitor.collectorConfig),
    filterConfig: jsonToString(monitor.filterConfig),
    cooldownSeconds: monitor.cooldownSeconds,
    dedupKeyTemplate: monitor.dedupKeyTemplate ?? '',
    escalateAgentId: monitor.escalateAgentId ?? '',
    perRunBudgetUsd: monitor.perRunBudgetUsd?.toString() ?? '',
    notifyChannel: monitor.notifyChannel ?? '',
  }

  const recentEscalations = runs.filter((r) => r.outcome === 'escalated').length

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Link href="/control-plane/monitors" className="text-sm text-ink-soft hover:text-ink">
              ← Monitorok
            </Link>
          </div>
          <h1 className="mt-2 font-display text-3xl font-semibold">{monitor.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className="text-sm text-ink-soft">{KIND_LABEL[monitor.kind] ?? monitor.kind}</span>
            <span
              className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[monitor.status] ?? ''}`}
            >
              {monitor.status}
            </span>
            {monitor.escalateAgentId && (
              <span className="inline-flex rounded bg-accent/10 px-2 py-0.5 text-xs text-accent">
                LLM eszkaláció
              </span>
            )}
          </div>
          {monitor.description && (
            <p className="mt-2 max-w-2xl text-sm text-ink-soft">{monitor.description}</p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <p className="text-xl font-semibold">{runs.length}</p>
            <p className="text-xs text-ink-soft">Futás (utolsó 30)</p>
          </div>
          <div>
            <p className="text-xl font-semibold text-amber-400">{recentEscalations}</p>
            <p className="text-xs text-ink-soft">Eszkaláció</p>
          </div>
          <div>
            <p className="text-xl font-semibold">{signals.length}</p>
            <p className="text-xs text-ink-soft">Aktív jel</p>
          </div>
        </div>
      </div>

      {canRun && (
        <Card title="Próba-futás (dry-run)">
          <DryRunPanel monitorId={monitor.id} />
        </Card>
      )}

      {canEdit && (
        <Card title="Beállítások szerkesztése">
          <MonitorEditorForm initial={formValues} agents={agents} />
        </Card>
      )}

      <Card title="Futásnapló">
        <MonitorRunLog runs={runs} />
      </Card>

      {signals.length > 0 && (
        <Card title={`Aktív jelek cooldown-nyilvántartása (${signals.length})`}>
          <div className="overflow-hidden rounded-lg border border-line/40">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line/40 bg-panel/60">
                  <th className="px-4 py-2 text-left font-medium text-ink-soft">Dedup-kulcs</th>
                  <th className="px-4 py-2 text-left font-medium text-ink-soft">Első megjelenés</th>
                  <th className="px-4 py-2 text-left font-medium text-ink-soft">Utolsó eszkaláció</th>
                  <th className="px-4 py-2 text-center font-medium text-ink-soft">Súlyosság</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s) => (
                  <tr key={s.id} className="border-b border-line/30 last:border-0">
                    <td className="px-4 py-2 font-mono text-xs text-ink-soft">{s.dedupKey}</td>
                    <td className="px-4 py-2 text-xs text-ink-soft">
                      {new Date(s.firstSeenAt).toLocaleString('hu-HU')}
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-soft">
                      {s.lastEscalatedAt
                        ? new Date(s.lastEscalatedAt).toLocaleString('hu-HU')
                        : '—'}
                    </td>
                    <td className="px-4 py-2 text-center text-ink-soft">{s.severity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
