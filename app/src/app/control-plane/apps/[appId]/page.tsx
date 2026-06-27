import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getSandboxApp } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'
import { SandboxAppVersionPanel } from '@/components/sandbox/sandbox-app-version-panel'
import { ArchiveSandboxAppButton } from '@/components/sandbox/archive-sandbox-app-button'
import { AddSandboxAppVersionToggle } from '@/components/sandbox/add-sandbox-app-version-toggle'

function statusTone(s: string): 'success' | 'neutral' | 'warning' | 'danger' {
  if (s === 'active') return 'success'
  if (s === 'blocked') return 'danger'
  if (s === 'archived') return 'neutral'
  return 'warning'
}

export default async function AppDetailPage({
  params,
}: {
  params: Promise<{ appId: string }>
}) {
  const { appId } = await params
  const res = await getSandboxApp({ appId })

  if (!res.success || !res.data) {
    notFound()
  }

  const { app, versions } = res.data

  return (
    <div className="space-y-6">
      {/* Fejléc */}
      <div>
        <div className="mb-2 flex items-center gap-2 text-sm text-ink-soft">
          <Link href="/control-plane/apps" className="hover:text-coral">
            App Registry
          </Link>
          <span>/</span>
          <span className="text-ink">{app.name}</span>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-semibold">{app.name}</h1>
            {app.description && (
              <p className="mt-1 text-sm text-ink-soft">{app.description}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(app.status)}>{app.status}</Badge>
            <Badge tone="neutral">A0 · single_html</Badge>
            <Badge tone="neutral">{app.criticality}</Badge>
            {app.status !== 'archived' && <ArchiveSandboxAppButton appId={app.appId} />}
          </div>
        </div>
      </div>

      {/* Metaadat */}
      <Card title="Metaadat">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Létrehozó
            </dt>
            <dd className="mt-0.5">
              <Badge tone={app.createdByLabel === 'agent' ? 'warning' : 'neutral'}>
                {app.createdByLabel}
              </Badge>
            </dd>
          </div>
          {app.createdFromTicketId && (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Eredet ticket
              </dt>
              <dd className="mt-0.5">
                <Link
                  href={`/control-plane/tickets/${app.createdFromTicketId}`}
                  className="font-mono text-xs text-ink-soft hover:text-coral"
                >
                  {app.createdFromTicketId.slice(0, 8)}…
                </Link>
              </dd>
            </div>
          )}
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Létrehozva
            </dt>
            <dd className="mt-0.5 text-ink-soft">
              {new Date(app.createdAt).toLocaleString('hu-HU', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Frissítve
            </dt>
            <dd className="mt-0.5 text-ink-soft">
              {new Date(app.updatedAt).toLocaleString('hu-HU', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
              App ID
            </dt>
            <dd className="mt-0.5 font-mono text-xs text-ink-faint">{app.appId}</dd>
          </div>
          {versions.find((v) => v.status === 'active') && (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Aktív verzió hash
              </dt>
              <dd className="mt-0.5 font-mono text-xs text-ink-faint">
                {versions.find((v) => v.status === 'active')?.contentHash.slice(0, 20)}…
              </dd>
            </div>
          )}
        </dl>
      </Card>

      {/* Manuális verzió hozzáadása */}
      {app.status !== 'archived' && (
        <AddSandboxAppVersionToggle appId={app.appId} />
      )}

      {/* Verziók + Preview (kliens komponens) */}
      {versions.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-faint">Még nincs verzió ehhez az apphoz.</p>
        </Card>
      ) : (
        <SandboxAppVersionPanel
          appId={app.appId}
          appName={app.name}
          activeVersionId={app.activeVersionId}
          versions={versions}
        />
      )}

      {/* Audit link (§7.2) */}
      <Card title="Audit">
        <p className="mb-3 text-sm text-ink-soft">
          Az app összes auditált eseménye — create, version, activate, preview, export, access_denied.
        </p>
        <Link
          href={`/control-plane/audit?targetType=sandbox_app&targetId=${app.appId}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-line px-4 py-1.5 text-xs font-semibold text-ink-soft hover:border-coral/40 hover:text-coral"
        >
          Audit eseményeinek megtekintése →
        </Link>
      </Card>
    </div>
  )
}
