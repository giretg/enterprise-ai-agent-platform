import { PlaybookPackImport } from '@/components/playbooks/playbook-pack-import'

export default function PlaybookPackImportPage() {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Governed Flow Builder</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Playbook Pack import</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Egy hordozható Playbook Pack (playbook + lépés-sablonok + connector-sablonok + dokumentáció)
          beolvasása, ellenőrzése és importálása. Az import CSAK vázlatot hoz létre — semmi nem lesz
          automatikusan élesítve, és titok/hozzáférés sosem utazik a packben (azt import után kell megadni).
        </p>
      </div>
      <PlaybookPackImport />
    </div>
  )
}
