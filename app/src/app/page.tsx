import type { Metadata } from 'next'
import Link from 'next/link'
import { PublicSiteShell } from '@/components/public-site/public-site-shell'

export const metadata: Metadata = {
  title: { absolute: 'Excellence AI — Kontrollált AI-munkatársak vállalatoknak' },
  description:
    'Excellence AI is a governed enterprise AI coworker platform. It lets companies give employees AI agents that work on company tools under access control, audit, and human approval.',
  robots: { index: true, follow: true },
}

const trust = ['Emberi jóváhagyás', 'Teljes audit-napló', 'Költségkeret', 'GDPR · EU-adatkezelés']

const features = [
  {
    title: 'AI-munkatársak, nem chatbotok',
    body: 'Az AI-munkatárs e-mailt olvas, dokumentumot készít, feladatot visz végig — a céged eszközeiben, a céged szabályai szerint.',
    icon: 'M4 6h16M4 12h10M4 18h7',
  },
  {
    title: 'Jogosultság és jóváhagyás',
    body: 'Te mondod meg, ki és melyik AI-munkatárs mihez férhet hozzá. Érzékeny műveletnél ember hagyja jóvá, mielőtt bármi kimenne.',
    icon: 'M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3zm-3 9l2 2 4-4',
  },
  {
    title: 'Visszakövethető munka',
    body: 'Minden lépés naplózva: ki kért mit, milyen adathoz nyúlt az AI, mit küldött ki. Utólag is végignézhető.',
    icon: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5',
  },
  {
    title: 'Admin-kontroll',
    body: 'A céges adminisztrátor állítja be, ki mit bízhat az AI-ra: szerepek, adat- és eszközhozzáférés, önállósági szint, költségkeret.',
    icon: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  },
]

// A platform által támogatott modell-szolgáltatók (lásd model-providers.ts).
const vendors = ['OpenAI', 'Anthropic', 'Google', 'xAI', 'OpenRouter']

const steps = [
  { title: 'Admin-kontroll beállítása', body: 'A céges adminisztrátor beállítja, ki melyik AI-munkatárssal, milyen adatokon és mekkora önállósággal dolgozhat.' },
  { title: 'Munka delegálása', body: 'Chatben, feladatként vagy ütemezett folyamatban. Az AI-munkatárs a céges rendszerekben viszi végig.' },
  { title: 'Ember dönt a kényes pontokon', body: 'Kimenő levél, fájlmegosztás, fizetés: jóváhagyó kártya, egy kattintás.' },
]

const chat = [
  { from: 'user', who: 'Kovács Anna', text: 'Léna, válaszold meg a reklamációs e-mailt a szabályzat alapján.' },
  {
    from: 'agent',
    who: 'Léna · ügyfélszolgálati AI',
    text: 'Megnéztem a tudásbázisban: 14 napos visszaküldés (v3). A piszkozat kész, jóváhagyásra várok.',
    draft: 'Kedves Gábor! A vásárlás értékét természetesen visszatérítjük a mai napon. Üdvözlettel: Léna',
  },
]

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}

export default function Home() {
  return (
    <PublicSiteShell>
      {/* ── Hero ─────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 -z-10 opacity-[0.35] [background-image:linear-gradient(var(--color-line)_1px,transparent_1px),linear-gradient(90deg,var(--color-line)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(60rem_30rem_at_50%_0%,black,transparent)]" />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-16 pt-16 sm:pt-24 lg:grid-cols-[1.1fr_0.9fr] lg:pb-24">
          <div className="animate-rise">
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1 text-xs font-medium text-ink-soft">
              <span className="h-1.5 w-1.5 rounded-full bg-sage animate-soul" />
              Kontrollált AI-munkatársak · EU-ban üzemeltetve
            </span>
            <h1 className="mt-6 font-display text-5xl font-semibold leading-[1.02] tracking-tight text-ink sm:text-7xl">
              <span className="whitespace-nowrap">AI-munkatársak,</span>
              <br />
              <em className="font-medium italic text-coral-deep">akiket kontrollálsz.</em>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-soft sm:text-xl">
              Adj a csapatodnak AI-munkatársakat, akik a céges rendszerekben dolgoznak —
              jogosultsággal, emberi jóváhagyással, visszakövethetően, költségkerettel.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/sign-in"
                className="group inline-flex items-center gap-2 rounded-full bg-coral px-6 py-3 text-sm font-semibold text-white shadow-[0_12px_30px_-12px_rgba(178,58,85,0.6)] transition-all hover:-translate-y-0.5 hover:bg-coral-deep"
              >
                Belépés
                <span className="transition-transform group-hover:translate-x-0.5">→</span>
              </Link>
              <a
                href="#hogyan"
                className="rounded-full border border-line bg-card px-6 py-3 text-sm font-semibold text-ink transition-colors hover:border-coral/40"
              >
                Hogyan működik?
              </a>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink-faint">
              {trust.map((t) => (
                <li key={t} className="flex items-center gap-1.5">
                  <span className="text-sage">✓</span>
                  {t}
                </li>
              ))}
            </ul>
          </div>

          {/* Chat mock — AI dolgozik a céges rendszerben */}
          <div className="atelier-card animate-rise overflow-hidden [animation-delay:120ms]">
            {/* ablak-fejléc */}
            <div className="flex items-center justify-between border-b border-line bg-card-2/60 px-5 py-3">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-coral text-xs font-semibold text-white">L</span>
                <div>
                  <p className="text-sm font-semibold text-ink">Léna</p>
                  <p className="text-[11px] text-ink-faint">ügyfélszolgálati AI-munkatárs · Claude Sonnet 4.6</p>
                </div>
              </div>
              <span className="flex items-center gap-1.5 rounded-full bg-sage/10 px-2.5 py-1 text-[11px] font-medium text-sage">
                <span className="h-1.5 w-1.5 rounded-full bg-sage animate-soul" />
                dolgozik
              </span>
            </div>
            <div className="space-y-4 px-5 py-5">
              {chat.map((m, i) => (
                <div key={i} className={`flex items-end gap-2.5 ${m.from === 'user' ? 'flex-row-reverse' : ''}`}>
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${m.from === 'user' ? 'bg-ink text-night' : 'bg-coral text-white'}`}>
                    {m.who[0]}
                  </span>
                  {/* buborék-színek = agent-chat-panel.tsx */}
                  <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm ${m.from === 'user' ? 'rounded-tr-md bg-coral/85 text-card' : 'rounded-tl-md border border-line bg-card/80 text-ink-soft'}`}>
                    {m.text}
                    {m.draft && (
                      <blockquote className="mt-2 border-l-2 border-line pl-3 text-xs italic leading-relaxed text-ink-faint">
                        {m.draft}
                      </blockquote>
                    )}
                  </div>
                </div>
              ))}
              {/* jóváhagyó kártya */}
              <div className="ml-[38px] rounded-xl border border-coral/30 bg-coral/[0.04] p-4">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-honey" />
                  <p className="text-xs font-semibold text-ink">Kimenő e-mail — jóváhagyásra vár</p>
                </div>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-ink-faint">Címzett</dt><dd className="text-ink">kiss.gabor@ugyfel.hu</dd>
                  <dt className="text-ink-faint">Tárgy</dt><dd className="text-ink">Re: Reklamáció — #4821</dd>
                  <dt className="text-ink-faint">Forrás</dt><dd className="text-ink">Visszaküldési szabályzat v3</dd>
                </dl>
                <div className="mt-3 flex gap-2">
                  <span className="rounded-full bg-coral px-4 py-1.5 text-xs font-semibold text-white">Jóváhagyom</span>
                  <span className="rounded-full border border-line px-4 py-1.5 text-xs font-medium text-ink-soft">Módosítást kérek</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-5 py-20">
        <p className="font-mono text-[12px] uppercase tracking-[0.16em] text-coral-deep">Miért Excellence AI</p>
        <h2 className="mt-3 max-w-2xl font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Professzionális céges kontroll az AI felett.
        </h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {features.map((f) => (
            <div key={f.title} className="atelier-card p-6 transition-transform hover:-translate-y-0.5 sm:p-7">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-coral/10 text-coral-deep">
                <Icon d={f.icon} />
              </span>
              <h3 className="mt-5 font-display text-xl font-semibold text-ink">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{f.body}</p>
            </div>
          ))}
          {/* modell-független */}
          <div className="atelier-card p-6 sm:col-span-2 sm:p-7 lg:flex lg:items-center lg:justify-between lg:gap-10">
            <div className="max-w-xl">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-coral/10 text-coral-deep">
                <Icon d="M4 7h16M4 12h16M4 17h16M8 4v3M16 9v3M11 14v3" />
              </span>
              <h3 className="mt-5 font-display text-xl font-semibold text-ink">AI-modelltől független</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                Nem kötünk egy szolgáltatóhoz. Akár AI-munkatársanként külön választhatod, melyik modell dolgozzon —
                és bármikor átválthatsz, ha jobb vagy olcsóbb jelenik meg.
              </p>
            </div>
            <ul className="mt-6 flex flex-wrap gap-2 lg:mt-0 lg:max-w-xs lg:justify-end">
              {vendors.map((v) => (
                <li key={v} className="rounded-full border border-line bg-card px-3.5 py-1.5 font-mono text-xs font-medium text-ink-soft">
                  {v}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────── */}
      <section id="hogyan" className="mx-auto max-w-6xl scroll-mt-20 px-5 pb-20">
        <div className="atelier-card p-8 sm:p-10">
          <p className="font-mono text-[12px] uppercase tracking-[0.16em] text-coral-deep">Hogyan működik</p>
          <div className="mt-6 grid gap-8 sm:grid-cols-3">
            {steps.map((s, i) => (
              <div key={s.title}>
                <p className="font-display text-4xl font-semibold text-coral/40">{i + 1}</p>
                <h3 className="mt-2 font-semibold text-ink">{s.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-soft">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── About / OAuth-verification copy (keep EN) ────────────── */}
      <section className="mx-auto max-w-6xl px-5 pb-24">
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <div>
            <h2 className="font-display text-2xl font-semibold text-ink">Mire való az Excellence AI?</h2>
            <p className="mt-4 leading-relaxed text-ink-soft">
              Az Excellence AI-t az Excellence Pay Kft. üzemelteti. A platform célja, hogy a cég
              munkatársai AI-munkatársakkal végezhessenek valós irodai munkát — levelezés, dokumentumok,
              belső tudás, jóváhagyott folyamatok — anélkül, hogy az adatok és a jogosultságok
              kicsúsznának a kezükből. Külső fiókok csatlakoztatása mindig opcionális, és a részleteket
              az adatkezelési tájékoztató írja le.
            </p>
          </div>
          <div className="atelier-soft p-6 text-sm leading-relaxed text-ink-soft">
            <p>
              <strong className="font-semibold text-ink">Excellence AI</strong> is a governed enterprise
              AI coworker platform operated by Excellence Pay Kft. It helps organizations give employees
              AI agents that work on company tools under access control, audit logging, privacy safeguards,
              and human approval.
            </p>
            <p className="mt-3">
              The product is not a public consumer chatbot. It is a signed-in workspace where invited
              company members run governed AI agents. External account connections are always optional
              and described in detail in the privacy documents. See the{' '}
              <Link href="/privacy" className="font-medium text-coral-deep underline underline-offset-2">
                Privacy Policy
              </Link>{' '}
              and{' '}
              <Link href="/gtc" className="font-medium text-coral-deep underline underline-offset-2">
                Terms
              </Link>
              .
            </p>
          </div>
        </div>

        {/* CTA band */}
        <div className="mt-16 overflow-hidden rounded-3xl bg-ink px-8 py-12 text-center text-night sm:px-12">
          <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            Az első AI-munkatársad már vár rád.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-night/70">
            Zárt, meghívásos munkatér. Lépj be a céges fiókoddal, és állítsd munkába az elsőt.
          </p>
          <Link
            href="/sign-in"
            className="mt-8 inline-flex items-center gap-2 rounded-full bg-coral px-7 py-3 text-sm font-semibold text-white transition-colors hover:bg-rose"
          >
            Belépés az Excellence AI-ba →
          </Link>
        </div>
      </section>
    </PublicSiteShell>
  )
}
