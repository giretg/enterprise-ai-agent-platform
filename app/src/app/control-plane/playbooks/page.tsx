import Link from 'next/link'
import { getCurrentUser } from '@/auth'
import { hasMinimumRole } from '@/auth/types'
import { listPlaybooksV2 } from '@/app/actions/playbook'
import { PlaybookRegistry, type PlaybookListView } from '@/components/playbooks/playbook-registry'

export default async function PlaybooksPage() {
  const [user, res] = await Promise.all([getCurrentUser(), listPlaybooksV2()])
  const canEdit = user ? hasMinimumRole(user.role, 'admin') : false
  const playbooks: PlaybookListView[] = res.success ? res.data : []

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Playbook</p>
          {canEdit && (
            <Link
              href="/control-plane/playbooks/import"
              className="rounded-lg border border-ink/20 px-3 py-1.5 text-sm hover:bg-ink/5"
            >
              ⇪ Pack import
            </Link>
          )}
        </div>
        <h1 className="mt-2 font-display text-3xl font-semibold">Playbookok</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          A Playbook egy közös, jóváhagyott folyamatleírás: megmondja, hogy egy adott munkát ki indít,
          milyen lépéseken kell végigvinni, mikor kell emberi jóváhagyás, és mikor tekinthető késznek.
          Úgy érdemes rá gondolni, mint a csapat ellenőrzőlistájára, amit az AI agentek és az emberek
          ugyanabból a forrásból követnek.
        </p>
      </div>
      <section className="atelier-card p-5">
        <h2 className="font-display text-lg font-semibold">Mire való és hogyan használd?</h2>
        <div className="mt-3 grid gap-4 text-sm leading-6 text-ink-soft md:grid-cols-3">
          <div>
            <h3 className="font-semibold text-ink">1. Készíts egy vázlatot</h3>
            <p className="mt-1">
              A <span className="font-medium text-ink">Létrehozás</span> gombbal hozz létre egy új Playbookot,
              majd írd le benne a folyamat lépéseit egyszerű, ellenőrizhető szabályokkal.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-ink">2. Ellenőriztesd és publikáld</h3>
            <p className="mt-1">
              A vázlat még módosítható. Publikálás előtt ellenőrizni kell, hogy a lépések, felelősök és
              jóváhagyási pontok egyértelműek-e.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-ink">3. Használd folyamatindításkor</h3>
            <p className="mt-1">
              A publikált verzió rögzül: ha egy ügy vagy ticket ezzel indul el, később is visszakereshető,
              pontosan melyik szabályrendszer szerint kellett dolgozni.
            </p>
          </div>
        </div>
      </section>
      {!res.success && (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
          Nem sikerült betölteni: {res.error}
        </p>
      )}
      <PlaybookRegistry playbooks={playbooks} canEdit={canEdit} />
    </div>
  )
}
