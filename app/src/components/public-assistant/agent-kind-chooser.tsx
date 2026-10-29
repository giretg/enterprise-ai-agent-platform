import Link from 'next/link'

/** #1016 D1: létrehozáskor választható típus — utólag nem váltható. */
export function AgentKindChooser({ selected }: { selected: 'internal' | 'public' }) {
  const card = (active: boolean) =>
    `block rounded-xl border p-4 transition ${active ? 'border-coral bg-coral/10' : 'border-line hover:border-coral/50'}`
  return (
    <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Milyen munkatársat hozol létre?">
      <Link href="/control-plane/agents/new" className={card(selected === 'internal')} role="radio" aria-checked={selected === 'internal'}>
        <p className="font-semibold text-ink">Belső munkatárs</p>
        <p className="mt-1 text-sm text-ink-soft">
          A kollégáidnak dolgozik: hozzáfér a céges rendszerekhez, tudásbázishoz és eszközökhöz, amiket megengedsz neki.
        </p>
      </Link>
      <Link href="/control-plane/agents/new?type=public" className={card(selected === 'public')} role="radio" aria-checked={selected === 'public'}>
        <p className="font-semibold text-ink">Nyilvános ügyfélszolgálati asszisztens</p>
        <p className="mt-1 text-sm text-ink-soft">
          Bárki beszélhet vele a weboldaladon vagy egy linken, bejelentkezés nélkül. Csak azt tudja, amit kifejezetten
          neki adsz — belső adatokhoz nem fér hozzá.
        </p>
      </Link>
      <p className="text-xs text-ink-soft sm:col-span-2">A típus később nem módosítható.</p>
    </div>
  )
}
