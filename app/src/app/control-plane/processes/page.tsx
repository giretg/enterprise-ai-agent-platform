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
          Itt indíthatók és követhetők azok a munkák, amelyek egy jóváhagyott Playbook szerint futnak.
          Egy folyamat mindig egy konkrét feladat végigvitele: látszik, hol tart, ki következik benne,
          és melyik szabályrendszer alapján kell haladni.
        </p>
      </div>

      <section className="atelier-card p-5">
        <h2 className="font-display text-lg font-semibold">Mire való és hogyan használd?</h2>
        <div className="mt-3 grid gap-4 text-sm leading-6 text-ink-soft md:grid-cols-3">
          <div>
            <h3 className="font-semibold text-ink">1. Válassz Playbookot</h3>
            <p className="mt-1">
              Új folyamatot csak publikált Playbookból lehet indítani. Ez biztosítja, hogy mindenki
              ugyanazokat a lépéseket és jóváhagyási pontokat kövesse.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-ink">2. Indítsd el a munkát</h3>
            <p className="mt-1">
              Az indítás után a rendszer létrehozza a folyamatot, és rögzíti, melyik Playbook-verzió
              alapján kell végigvinni.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-ink">3. Kövesd az állapotát</h3>
            <p className="mt-1">
              Az aktív és lezárt folyamatok listájában látod, mi fut, mi vár emberi döntésre, és mi zárult
              le. Így nem kell külön kérdezgetni, hol akadt el a munka.
            </p>
          </div>
        </div>
      </section>

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
