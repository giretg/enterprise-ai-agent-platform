import type { Metadata } from 'next'
import Link from 'next/link'
import { PublicSiteShell } from '@/components/public-site/public-site-shell'

export const metadata: Metadata = {
  title: { absolute: 'Excellence AI' },
  description:
    'Excellence AI is a governed enterprise AI coworker platform. It lets companies give employees AI agents that can use company tools — including Gmail and Google Drive — under access control, audit, and human approval.',
  robots: { index: true, follow: true },
}

const features = [
  {
    title: 'AI-munkatársak, nem chatbotok',
    body: 'Az Excellence AI ügynökei e-mailt olvasnak, dokumentumot készítenek, feladatot visznek végig — a céged eszközein, a céged szabályai szerint.',
  },
  {
    title: 'Jogosultság és jóváhagyás',
    body: 'Pontosan megmondhatod, melyik ember és melyik AI-ügynök mihez férhet. Érzékeny műveletnél emberi jóváhagyás kell, mielőtt bármi kimenne.',
  },
  {
    title: 'Auditálható munka',
    body: 'Minden futás naplózott: ki kért mit, milyen eszközhöz nyúlt az ügynök, mit küldött ki. A vezetőség utólag is végig tudja nézni.',
  },
  {
    title: 'Google-fiók, kontroll alatt',
    body: 'Ha a felhasználó összeköti a Gmailt vagy a Google Drive-ot, az ügynök a saját fiókjában dolgozik. A kapcsolat bármikor bontható.',
  },
]

export default function Home() {
  return (
    <PublicSiteShell>
      <section className="mx-auto max-w-5xl px-5 pb-20 pt-16 sm:pt-24">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-coral-deep">Excellence AI</p>
        <h1 className="mt-4 max-w-3xl font-display text-4xl font-semibold tracking-tight text-ink sm:text-6xl">
          Excellence AI
        </h1>
        <p className="mt-6 max-w-2xl text-xl leading-relaxed text-ink-soft">
          Kontrollált vállalati AI-munkatárs platform. A kis- és középvállalat a munkatársainak AI
          ügynököket adhat — jogosultsággal, auditálhatóan, költségkerettel.
        </p>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-ink-soft">
          <strong className="font-semibold text-ink">Excellence AI</strong> is a governed enterprise
          AI coworker platform. It helps organizations give employees AI agents that can use company
          tools — including Gmail and Google Drive, when a user chooses to connect them — under
          access control, audit logging, privacy safeguards, and human approval.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/sign-in"
            className="rounded-full bg-coral px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-coral-deep"
          >
            Belépés az Excellence AI-ba
          </Link>
          <Link
            href="/privacy"
            className="rounded-full border border-line bg-card px-6 py-3 text-sm font-semibold text-ink hover:border-coral/40"
          >
            Adatvédelem
          </Link>
        </div>
      </section>

      <section className="mx-auto grid max-w-5xl gap-4 px-5 pb-20 sm:grid-cols-2">
        {features.map((feature) => (
          <div key={feature.title} className="atelier-card p-6">
            <h2 className="font-display text-xl font-semibold text-ink">{feature.title}</h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">{feature.body}</p>
          </div>
        ))}
      </section>

      <section className="mx-auto max-w-5xl px-5 pb-24">
        <div className="atelier-card p-8 sm:p-10">
          <h2 className="font-display text-2xl font-semibold text-ink">Mire való az Excellence AI?</h2>
          <p className="mt-4 max-w-3xl leading-relaxed text-ink-soft">
            Az Excellence AI-t az Excellence Pay Kft. üzemelteti. A platform célja, hogy a cég
            munkatársai AI-ügynökökkel végezhessenek valós irodai munkát — levelezés, dokumentumok,
            belső tudás, jóváhagyott folyamatok — anélkül, hogy az adatok és a jogosultságok
            kicsúsznának a kezükből. A Google-fiók csatlakoztatása opcionális: csak akkor kérjük,
            ha a felhasználó Gmailt vagy Drive-ot akar az ügynöknek adni, és csak a kért
            funkcióhoz.
          </p>
          <p className="mt-4 max-w-3xl leading-relaxed text-ink-soft">
            Excellence AI is operated by Excellence Pay Kft. The product is not a public consumer
            chatbot. It is a signed-in workspace where invited company members run governed AI
            agents. Google user data is accessed only after the user connects a Google account, and
            only to perform the features the user requested. See the{' '}
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
      </section>
    </PublicSiteShell>
  )
}
