import Link from 'next/link'
import { listSandboxApps, getSandboxAppRegistryMetrics } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'
import { CreateSandboxAppToggle } from '@/components/sandbox/create-sandbox-app-toggle'

function statusTone(status: string): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'active') return 'success'
  if (status === 'blocked') return 'danger'
  if (status === 'archived') return 'neutral'
  return 'warning'
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-line px-4 py-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="mt-1 font-display text-2xl font-semibold tabular-nums">{value}</dd>
      {hint && <p className="mt-0.5 text-xs text-ink-faint">{hint}</p>}
    </div>
  )
}

export default async function AppRegistryPage() {
  const [res, metricsRes] = await Promise.all([
    listSandboxApps({}),
    getSandboxAppRegistryMetrics(),
  ])
  const apps = res.success ? res.data.apps : []
  const metrics = metricsRes.success ? metricsRes.data : null

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">
            Sandbox Plane
          </p>
          <h1 className="mt-2 font-display text-3xl font-semibold">Mini-appok</h1>
          <p className="mt-1 max-w-2xl text-ink-soft">
            Agent (vagy ember) által készített, verziózott mini-appok (A0 single-file HTML). Izolált
            preview, export, rollback — platform session és hálózat nélkül.
          </p>
        </div>
        <CreateSandboxAppToggle />
      </div>

      {/* Observability metrikák (§8.3) */}
      {metrics && metrics.appsTotal > 0 && (
        <Card title="Metrikák">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Metric
              label="Mini-appok"
              value={String(metrics.appsTotal)}
              hint={`${metrics.appsByCreator.agent} agent · ${metrics.appsByCreator.user} ember`}
            />
            <Metric
              label="Verziók"
              value={String(metrics.versionsTotal)}
              hint={`átlag ${metrics.avgVersionsPerApp.toFixed(1)} / app`}
            />
            <Metric
              label="Átlag méret"
              value={`${(metrics.avgArtifactSizeBytes / 1024).toFixed(1)} KB`}
            />
            <Metric label="Aktív" value={String(metrics.appsByStatus.active ?? 0)} />
            <Metric label="Preview" value={String(metrics.events.preview)} />
            <Metric label="Export" value={String(metrics.events.export)} />
            <Metric
              label="Validációs hiba"
              value={String(metrics.events.validationFailed)}
            />
            <Metric label="Access denied" value={String(metrics.events.accessDenied)} />
          </dl>
        </Card>
      )}

      {!res.success && (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
          Nem sikerült betölteni az appokat: {res.error}
        </p>
      )}

      {apps.length === 0 && res.success && (
        <Card>
          <p className="text-sm text-ink-faint">
            Még nincs mini-app ebben a tenantban. Kézzel a{' '}
            <strong>Mini-app létrehozása</strong> gombbal, az agent a{' '}
            <code className="rounded bg-night-2 px-1.5 py-0.5 font-mono text-xs">
              sandbox_app.create
            </code>{' '}
            tool-lal, vagy a ticket részletező oldalán a{' '}
            <strong>Riport létrehozása</strong> gombbal hozhatsz létre egyet.
          </p>
        </Card>
      )}

      {apps.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-night-1/40">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-ink-soft">Név</th>
                <th className="px-4 py-3 text-left font-semibold text-ink-soft">Státusz</th>
                <th className="px-4 py-3 text-left font-semibold text-ink-soft">Verzió</th>
                <th className="px-4 py-3 text-left font-semibold text-ink-soft">Létrehozó</th>
                <th className="px-4 py-3 text-left font-semibold text-ink-soft">Eredet</th>
                <th className="px-4 py-3 text-left font-semibold text-ink-soft">Hash</th>
                <th className="px-4 py-3 text-left font-semibold text-ink-soft">Frissítve</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {apps.map((app) => (
                <tr key={app.appId} className="hover:bg-night-1/20 transition-colors">
                  <td className="px-4 py-3">
                    <Link
                      href={`/control-plane/apps/${app.appId}`}
                      className="font-medium text-ink hover:text-coral"
                    >
                      {app.name}
                    </Link>
                    {app.description && (
                      <p className="mt-0.5 text-xs text-ink-faint line-clamp-1">
                        {app.description}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={statusTone(app.status)}>{app.status}</Badge>
                  </td>
                  <td className="px-4 py-3 text-ink-soft">
                    {app.activeVersion !== undefined ? `v${app.activeVersion}` : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={app.createdByLabel === 'agent' ? 'warning' : 'neutral'}>
                      {app.createdByLabel}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    {app.createdFromTicketId ? (
                      <Link
                        href={`/control-plane/tickets/${app.createdFromTicketId}`}
                        className="font-mono text-[11px] text-ink-faint hover:text-coral"
                      >
                        #{app.createdFromTicketId.slice(0, 8)}
                      </Link>
                    ) : (
                      <span className="text-xs text-ink-faint">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-faint">
                    {app.contentHash ? app.contentHash.slice(0, 12) : '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-soft">
                    {new Date(app.updatedAt).toLocaleString('hu-HU', {
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
    </div>
  )
}
