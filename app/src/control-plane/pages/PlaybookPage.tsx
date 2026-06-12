import { Badge } from '../../shared/components/Badge'
import { Card } from '../../shared/components/Card'
import { useDemo } from '../../shared/context/DemoContext'

const actorIcon = {
  human: '👤',
  agent: '🤖',
  system: '⚙️',
} as const

export function PlaybookPage() {
  const { playbookIntended, playbookActual } = useDemo()

  const matchedCount = playbookActual.filter((a) => a.matched).length
  const compliancePct = Math.round(
    (matchedCount / playbookIntended.length) * 100,
  )

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-50">Playbook</h1>
          <p className="mt-1 text-sm text-slate-400">
            Szándékolt folyamat vs. tényleges végrehajtás (audit-log alapján)
          </p>
        </div>
        <Badge variant={compliancePct >= 80 ? 'success' : 'warning'}>
          {compliancePct}% egyezés — Számlafeldolgozás playbook
        </Badge>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Szándékolt folyamat (playbook)">
          <ol className="space-y-0">
            {playbookIntended.map((step, i) => (
              <li key={step.id} className="relative flex gap-4 pb-6 last:pb-0">
                {i < playbookIntended.length - 1 && (
                  <span className="absolute left-[15px] top-8 h-full w-px bg-slate-700" />
                )}
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-sky-700 bg-sky-950/50 text-xs font-bold text-sky-300">
                  {step.order}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span>{actorIcon[step.actor]}</span>
                    <span className="font-medium text-slate-200">{step.label}</span>
                    <Badge variant="mono">{step.actor}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{step.description}</p>
                </div>
              </li>
            ))}
          </ol>
        </Card>

        <Card title="Tényleges végrehajtás (audit log)">
          {playbookActual.length === 0 ? (
            <p className="text-sm text-slate-500">
              Még nincs releváns audit esemény. Futtasd le a Sandbox demót (számla
              feltöltés → jóváhagyás).
            </p>
          ) : (
            <ol className="space-y-0">
              {playbookActual.map((step, i) => (
                <li key={step.id} className="relative flex gap-4 pb-6 last:pb-0">
                  {i < playbookActual.length - 1 && (
                    <span className="absolute left-[15px] top-8 h-full w-px bg-slate-700" />
                  )}
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-bold ${
                      step.matched
                        ? 'border-emerald-700 bg-emerald-950/50 text-emerald-300'
                        : 'border-amber-700 bg-amber-950/50 text-amber-300'
                    }`}
                  >
                    {step.order}
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-200">{step.label}</span>
                      <Badge variant="mono">{step.auditAction}</Badge>
                      {step.matched && <Badge variant="success">✓</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {new Date(step.timestamp).toLocaleString('hu-HU')}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-4 text-xs text-slate-600">
            A tényleges lépések a session audit logjából származnak — új demó
            futtatásakor frissülnek.
          </p>
        </Card>
      </div>

      <Card title="Eltérések és megfelelőség" className="mt-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded border border-slate-700/50 p-4 text-center">
            <p className="text-2xl font-semibold text-slate-100">
              {playbookIntended.length}
            </p>
            <p className="text-xs text-slate-500">Szándékolt lépés</p>
          </div>
          <div className="rounded border border-slate-700/50 p-4 text-center">
            <p className="text-2xl font-semibold text-emerald-300">
              {playbookActual.length}
            </p>
            <p className="text-xs text-slate-500">Naplózott lépés (session)</p>
          </div>
          <div className="rounded border border-slate-700/50 p-4 text-center">
            <p className="text-2xl font-semibold text-sky-300">{compliancePct}%</p>
            <p className="text-xs text-slate-500">Playbook lefedettség</p>
          </div>
        </div>
        <p className="mt-4 text-sm text-slate-400">
          A „Audit naplózás” lépés minden művelet után automatikusan teljesül —
          ez a platform alapgaranciája. A playbook nézet bizonyítja, hogy a
          szándékolt üzleti folyamat visszakövethető a tényleges agent-műveletekre.
        </p>
      </Card>
    </div>
  )
}
