import Link from 'next/link'
import { getCurrentUser } from '@/auth'
import { hasMinimumRole } from '@/auth/types'
import { listProcesses } from '@/app/actions/process'
import { listStartablePlaybooks } from '@/app/actions/playbook'
import { StartProcessForm, type StartablePlaybook } from '@/components/processes/start-process-form'

const PROC_TONE: Record<string, string> = {
  created: 'bg-ink/8 text-ink-soft',
  running: 'bg-sky-500/15 text-sky-300',
  awaiting_human: 'bg-honey/15 text-honey',
  blocked: 'bg-coral/15 text-coral',
  completed: 'bg-sage/15 text-sage',
  failed: 'bg-coral/15 text-coral',
  cancelled: 'bg-ink/8 text-ink-soft',
}

export default async function ProcessesPage() {
  const [user, processesRes, startableRes] = await Promise.all([
    getCurrentUser(),
    listProcesses(),
    listStartablePlaybooks(),
  ])
  const canStart = user ? hasMinimumRole(user.role, 'operator') : false
  const startable: StartablePlaybook[] = startableRes.success ? startableRes.data : []
  const processes = processesRes.success ? processesRes.data : []

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Playbook</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Folyamatok</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Playbook-vezérelt, több szereplős folyamatok. A kötelező kapukat a szerveroldali
          állapotgép kényszeríti ki — az agent nem kerülheti meg, és a futás végig a pin-elt
          Playbook-verzión megy.
        </p>
      </div>

      {canStart && (
        <section className="atelier-card p-5">
          <h2 className="mb-4 font-display text-lg font-semibold">Új folyamat indítása</h2>
          <StartProcessForm playbooks={startable} />
        </section>
      )}

      <section className="atelier-card p-5">
        <h2 className="mb-4 font-display text-lg font-semibold">Aktív és lezárt folyamatok</h2>
        {!processesRes.success && (
          <p className="text-sm text-coral">Nem sikerült betölteni: {processesRes.error}</p>
        )}
        <ul className="divide-y divide-ink/8">
          {processes.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <Link href={`/control-plane/processes/${p.id}`} className="group">
                <span className="font-medium group-hover:text-accent">{p.processType}</span>
                <span className="ml-2 font-mono text-xs text-ink-soft">{p.playbookRef}</span>
              </Link>
              <div className="flex items-center gap-3">
                <span className="text-xs text-ink-soft">
                  {new Date(p.startedAt).toLocaleString('hu-HU')}
                </span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    PROC_TONE[p.status] ?? 'bg-ink/8 text-ink-soft'
                  }`}
                >
                  {p.status}
                </span>
              </div>
            </li>
          ))}
          {processes.length === 0 && <li className="py-3 text-sm text-ink-soft">Még nincs folyamat.</li>}
        </ul>
      </section>
    </div>
  )
}
