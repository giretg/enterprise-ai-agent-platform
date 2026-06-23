import Link from 'next/link'
import { getCurrentUser } from '@/auth'
import { hasMinimumRole } from '@/auth/types'
import { listMonitors } from '@/app/actions/monitor'
import { MonitorList, type MonitorListView } from '@/components/monitors/monitor-list'

export default async function MonitorsPage() {
  const [user, monitorsRes] = await Promise.all([getCurrentUser(), listMonitors()])
  const canEdit = user ? hasMinimumRole(user.role, 'admin') : false

  const monitors: MonitorListView[] = monitorsRes.success
    ? monitorsRes.data.map((m) => ({
        id: m.id,
        title: m.title,
        kind: m.kind,
        status: m.status,
        nextSweepAt: m.nextSweepAt?.toISOString() ?? null,
        lastSweepAt: m.lastSweepAt?.toISOString() ?? null,
        intervalSeconds: m.intervalSeconds,
        escalateAgentId: m.escalateAgentId,
      }))
    : []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Proaktív figyelés</p>
          <h1 className="mt-2 font-display text-3xl font-semibold">Monitorok</h1>
          <p className="mt-1 max-w-2xl text-ink-soft">
            Ütemezett, nem-LLM söprés (1. lépcső) — csak küszöböt átlépő jelnél nyit ticketet. A
            csendes alapállapot nulla LLM-tokent jelent.
          </p>
        </div>
        {canEdit && (
          <Link
            href="/control-plane/monitors/new"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            + Új monitor
          </Link>
        )}
      </div>

      {!monitorsRes.success && (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
          Nem sikerült betölteni a monitorokat: {monitorsRes.error}
        </p>
      )}

      <MonitorList monitors={monitors} canEdit={canEdit} />
    </div>
  )
}
