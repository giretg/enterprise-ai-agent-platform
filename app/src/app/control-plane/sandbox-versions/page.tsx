import Link from 'next/link'
import { listSandboxProjects } from '@/app/actions/sandbox-versioning'
import { Badge, Card } from '@/components/ui/shell'
import { CreateSandboxProjectToggle } from '@/components/sandbox/create-sandbox-project-toggle'
import { evaluateGraduationReadiness } from '@/lib/sandbox-portability'

export default async function SandboxVersionsPage() {
  const res = await listSandboxProjects()
  const projects = res.success ? res.data : []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Sandbox Plane</p>
          <h1 className="mt-2 font-display text-3xl font-semibold">Sandbox verziók</h1>
          <p className="mt-1 max-w-2xl text-ink-soft">
            Verziózott projektek: git-szerű commit-fa, test→live promóció emberi go-live kapuval, és
            pont-idejű adat-snapshot. A kód és az adat két külön sín — egy rossz deploy visszavonása
            soha nem veszi el a rögzített üzleti adatot.
          </p>
        </div>
        <CreateSandboxProjectToggle />
      </div>

      {!res.success && (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
          Nem sikerült betölteni a projekteket: {res.error}
        </p>
      )}

      {res.success && projects.length === 0 && (
        <Card>
          <p className="text-sm text-ink-faint">
            Még nincs sandbox projekt ebben a tenantban. Hozz létre egyet a{' '}
            <strong>Projekt létrehozása</strong> gombbal, vagy az agent a{' '}
            <code className="rounded bg-night-2 px-1.5 py-0.5 font-mono text-xs">sandbox.commit</code>{' '}
            tool-lal commitolhat egy meglévőbe.
          </p>
        </Card>
      )}

      {projects.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-night-1/40">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-ink-soft">Projekt</th>
                <th className="px-4 py-3 text-left font-semibold text-ink-soft">Test</th>
                <th className="px-4 py-3 text-left font-semibold text-ink-soft">Live</th>
                <th className="px-4 py-3 text-left font-semibold text-ink-soft">Graduation</th>
                <th className="px-4 py-3 text-left font-semibold text-ink-soft">Frissítve</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {projects.map((p) => {
                const readiness = evaluateGraduationReadiness(p.portability)
                return (
                <tr key={p.projectId} className="transition-colors hover:bg-night-1/20">
                  <td className="px-4 py-3">
                    <Link
                      href={`/control-plane/sandbox-versions/${p.projectId}`}
                      className="font-medium text-ink hover:text-coral"
                    >
                      {p.name}
                    </Link>
                    {p.description && (
                      <p className="mt-0.5 line-clamp-1 text-xs text-ink-faint">{p.description}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-soft">
                    {p.testCommitId ? p.testCommitId.slice(0, 8) : '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-soft">
                    {p.liveCommitId ? p.liveCommitId.slice(0, 8) : '— (nincs élesítve)'}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={readiness.tone} title={readiness.failingChecks.join(', ') || undefined}>
                      {readiness.label}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-soft">
                    {new Date(p.updatedAt).toLocaleString('hu-HU', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
