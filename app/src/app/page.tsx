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
    n: '01',
    title: 'AI-munkatársak, nem chatbotok',
    body: 'Az ügynökök e-mailt olvasnak, dokumentumot készítenek, feladatot visznek végig — a céged eszközein, a céged szabályai szerint.',
    icon: 'M4 6h16M4 12h10M4 18h7',
    span: true,
  },
  {
    n: '02',
    title: 'Jogosultság és jóváhagyás',
    body: 'Pontosan megmondod, ki és melyik ügynök mihez fér. Érzékeny műveletnél ember mond igent, mielőtt bármi kimenne.',
    icon: 'M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3zm-3 9l2 2 4-4',
    span: false,
  },
  {
    n: '03',
    title: 'Auditálható munka',
    body: 'Minden lépés visszakövethető: ki kért mit, milyen adathoz nyúlt az ügynök, mit küldött ki. Utólag is végignézhető.',
    icon: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5',
    span: false,
  },
  {
    n: '04',
    title: 'Ember + AI, admin-kontrollal',
    body: 'A céges adminisztrátor szabályozza, ki mit bízhat az AI-ra: szerepek, adat- és eszközhozzáférés, önállósági szint, költségkeret.',
    icon: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
    span: true,
  },
]

const steps = [
  { title: 'Admin-kontroll beállítása', body: 'A céges adminisztrátor megszabja: ki, melyik ügynökkel, milyen adatokon és milyen önállósággal dolgozhat.' },
  { title: 'Munka delegálása', body: 'Chatben, ticketben vagy ütemezett folyamatban. Az ügynök végigviszi a céges rendszerben.' },
  { title: 'Ember dönt a kényes pontokon', body: 'Kimenő levél, megosztás, fizetés: jóváhagyó kártya, egy kattintás.' },
]

const chat = [
  { from: 'user', who: 'Kovács Anna', text: 'Léna, válaszold meg a reklamációs e-mailt a szabályzat alapján.' },
  { from: 'agent', who: 'Léna · ügyfélszolgálati AI', text: 'Megnéztem a tudásbázisban: 14 napos visszaküldés (v3). A piszkozat kész, jóváhagyásra várok.' },
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
              Governed AI coworkers · EU-ban üzemeltetve
            </span>
            <h1 className="mt-6 font-display text-5xl font-semibold leading-[1.02] tracking-tight text-ink sm:text-7xl">
              AI-munkatársak,
              <br />
              <em className="font-medium italic text-coral-deep">akiket kontrollálsz.</em>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-soft sm:text-xl">
              Adj a csapatodnak AI-ügynököket, amik a céges eszközökön dolgoznak —
              jogosultsággal, jóváhagyással, auditálhatóan, költségkerettel.
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
          <div className="atelier-card animate-rise p-5 [animation-delay:120ms] sm:p-6">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">Céges tér · Léna</p>
              <span className="flex items-center gap-1.5 text-xs text-sage">
                <span className="h-1.5 w-1.5 rounded-full bg-sage animate-soul" />
                dolgozik
              </span>
            </div>
            <div className="mt-4 space-y-3">
              {chat.map((m, i) => (
                <div key={i} className={`flex ${m.from === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${m.from === 'user' ? 'rounded-br-md bg-ink text-night' : 'rounded-bl-md border border-line bg-card'}`}>
                    <p className="text-sm leading-relaxed">{m.text}</p>
                    <p className={`mt-1 text-[11px] ${m.from === 'user' ? 'text-night/60' : 'text-ink-faint'}`}>{m.who}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="atelier-soft mt-4 flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-xs font-medium text-ink">Kimenő levél — jóváhagyásra vár</p>
                <p className="text-xs text-ink-faint">Címzett, tartalom, jogszint — mind látszik.</p>
              </div>
              <span className="rounded-full bg-coral px-3 py-1 text-xs font-semibold text-white">Jóváhagyom</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-5 py-20">
        <p className="font-mono text-[12px] uppercase tracking-[0.16em] text-coral-deep">Miért Excellence AI</p>
        <h2 className="mt-3 max-w-2xl font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Kormányzás beépítve, nem utólag rácsavarva.
        </h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.n}
              className={`atelier-card group relative overflow-hidden p-6 transition-transform hover:-translate-y-0.5 sm:p-7 ${f.span ? 'sm:col-span-2 lg:col-span-2' : ''}`}
            >
              <span className="pointer-events-none absolute -right-2 -top-4 font-display text-[88px] font-semibold leading-none text-ink/[0.05] select-none">
                {f.n}
              </span>
              <div className="flex items-center justify-between">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-coral/10 text-coral-deep">
                  <Icon d={f.icon} />
                </span>
                <span className="font-mono text-xs text-ink-faint">{f.n}</span>
              </div>
              <h3 className="mt-5 font-display text-xl font-semibold text-ink sm:text-2xl">{f.title}</h3>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-soft">{f.body}</p>
            </div>
          ))}
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
              munkatársai AI-ügynökökkel végezhessenek valós irodai munkát — levelezés, dokumentumok,
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
            Készen áll az első AI-munkatársad.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-night/70">
            Zárt, meghívásos munkatér. Lépj be a céges fiókoddal, és vedd fel az elsőt.
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
