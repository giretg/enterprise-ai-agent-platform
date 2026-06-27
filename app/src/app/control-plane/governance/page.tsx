import Link from 'next/link'
import { getGovernanceReport } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'

type Range = 'today' | '7d' | '30d' | 'all'

const RANGE_LABELS: Record<Range, string> = {
  today: 'Ma',
  '7d': '7 nap',
  '30d': '30 nap',
  all: 'Összes',
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`
}

export default async function GovernancePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>
}) {
  const { range: rawRange } = await searchParams
  const range: Range =
    rawRange === '7d' || rawRange === '30d' || rawRange === 'all' ? rawRange : 'today'

  const res = await getGovernanceReport({ range })
  const report = res.success ? res.data : null

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Governance &amp; mérés</h1>
          <p className="mt-1 text-ink-soft">
            A két átjáró forgalma, kontroll-lépések és audit-lánc — egy helyen (Epik 8, §11).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <nav className="flex gap-1 rounded-full bg-ink/5 p-1">
            {(Object.keys(RANGE_LABELS) as Range[]).map((r) => (
              <Link
                key={r}
                href={`/control-plane/governance?range=${r}`}
                className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                  r === range
                    ? 'bg-card text-ink shadow-sm'
                    : 'text-ink-faint hover:text-ink-soft'
                }`}
              >
                {RANGE_LABELS[r]}
              </Link>
            ))}
          </nav>
          <a
            href={`/control-plane/governance/report?range=${range}`}
            className="rounded-full border border-ink/15 px-3 py-1.5 text-sm font-medium text-ink-soft transition-colors hover:bg-ink/5"
            title="Mérési riport letöltése Markdown formátumban (§9.1/7)"
          >
            ⬇ Mérési riport
          </a>
          <Link
            href="/control-plane/governance/evals"
            className="rounded-full border border-ink/15 px-3 py-1.5 text-sm font-medium text-ink-soft transition-colors hover:bg-ink/5"
          >
            Eval ellenőrzések
          </Link>
        </div>
      </div>

      {!report ? (
        <Card>
          <p className="py-8 text-center text-ink-faint">
            {res.success ? 'Nincs adat' : `Hiba: ${res.error}`}
          </p>
        </Card>
      ) : (
        <>
          {/* KPI strip — §11 dimenziók aggregálva */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <span className="text-2xl" aria-hidden>
                🧠
              </span>
              <p className="mt-3 font-display text-[2rem] leading-none text-ink">
                {report.model.calls}
              </p>
              <p className="mt-1.5 text-sm text-ink-faint">Gateway-hívás</p>
              <p className="mt-1 text-xs text-ink-faint">
                átlag {report.model.avgLatencyMs} ms · {report.model.errorCalls} hiba ·{' '}
                {report.model.rateLimitedCalls} rate-limit
              </p>
            </Card>
            <Card>
              <span className="text-2xl" aria-hidden>
                🔧
              </span>
              <p className="mt-3 font-display text-[2rem] leading-none text-ink">
                {report.tools.calls}
              </p>
              <p className="mt-1.5 text-sm text-ink-faint">Tool Broker-hívás</p>
              <p className="mt-1 text-xs text-ink-faint">
                {report.tools.denied} tiltva · {report.tools.errors} hiba
              </p>
            </Card>
            <Card>
              <span className="text-2xl" aria-hidden>
                🪙
              </span>
              <p className="mt-3 font-display text-[2rem] leading-none text-ink">
                {report.model.tokens.toLocaleString('hu-HU')}
              </p>
              <p className="mt-1.5 text-sm text-ink-faint">Token</p>
              <p className="mt-1 text-xs text-ink-faint">
                becsült költség €{report.model.cost.toFixed(4)}
              </p>
            </Card>
            <Card>
              <span className="text-2xl" aria-hidden>
                🤝
              </span>
              <p className="mt-3 font-display text-[2rem] leading-none text-ink">
                {pct(report.control.humanShare)}
              </p>
              <p className="mt-1.5 text-sm text-ink-faint">Emberi lépés-arány</p>
              <p className="mt-1 text-xs text-ink-faint">
                {report.control.decisions} döntés · {pct(report.control.rejectionRate)} visszadobás
              </p>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            {/* Kontroll — átmenetek actor szerint */}
            <Card title="Kontroll — lépések eredete" className="lg:col-span-1">
              <ul className="space-y-3 text-sm">
                {(['human', 'agent', 'system'] as const).map((actor) => (
                  <li
                    key={actor}
                    className="flex items-center justify-between atelier-soft p-3"
                  >
                    <span className="capitalize">
                      {actor === 'human' ? 'Ember' : actor === 'agent' ? 'Ágens' : 'Rendszer'}
                    </span>
                    <span className="font-display text-lg">{report.transitions.byActor[actor]}</span>
                  </li>
                ))}
                <li className="flex items-center justify-between p-3 text-ink-faint">
                  <span>Jóváhagyva / elutasítva</span>
                  <span className="font-mono text-xs">
                    {report.transitions.toApproved} / {report.transitions.toRejected}
                  </span>
                </li>
              </ul>
            </Card>

            {/* Audit-lánc integritás */}
            <Card title="Audit-lánc integritás" className="lg:col-span-1">
              <div className="flex items-center gap-3">
                <Badge tone={report.chain.ok ? 'success' : 'danger'}>
                  {report.chain.ok ? 'Ép' : 'Sérült'}
                </Badge>
                <span className="text-sm text-ink-soft">
                  {report.chain.checked} bejegyzés ellenőrizve
                </span>
              </div>
              {!report.chain.ok && (
                <p className="mt-3 text-sm text-coral-deep">
                  Törés a(z) {report.chain.firstBreakSeq}. szekvenciánál.
                </p>
              )}
              <p className="mt-4 text-xs text-ink-faint">
                A teljes láncellenőrzés a{' '}
                <Link href="/control-plane/audit" className="text-coral-deep hover:underline">
                  Audit
                </Link>{' '}
                oldalon futtatható.
              </p>
            </Card>

            {/* Sandbox app (CR-MVP-001) */}
            <Card title="Sandbox appok (CR-MVP-001)" className="lg:col-span-1">
              <ul className="space-y-2 text-sm">
                {[
                  ['Létrehozva', report.sandbox.created],
                  ['Új verzió', report.sandbox.versions],
                  ['Preview', report.sandbox.previews],
                  ['Export', report.sandbox.exports],
                  ['Megtagadott hozzáférés', report.sandbox.accessDenied],
                ].map(([label, value]) => (
                  <li key={label} className="flex items-center justify-between">
                    <span className="text-ink-soft">{label}</span>
                    <span
                      className={`font-display text-lg ${
                        label === 'Megtagadott hozzáférés' && (value as number) > 0
                          ? 'text-coral-deep'
                          : 'text-ink'
                      }`}
                    >
                      {value}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          {/* Ticketenkénti lebontás */}
          <Card title="Ticketenkénti lebontás">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-ink-faint">
                    <th className="pb-2 pr-4 text-xs">Ügy</th>
                    <th className="pb-2 pr-4 text-right text-xs">Gateway</th>
                    <th className="pb-2 pr-4 text-right text-xs">Tool</th>
                    <th className="pb-2 pr-4 text-right text-xs">Token</th>
                    <th className="pb-2 pr-4 text-right text-xs">Átlag késleltetés</th>
                    <th className="pb-2 text-right text-xs">Költség</th>
                  </tr>
                </thead>
                <tbody>
                  {report.perTicket.map((t) => (
                    <tr key={t.ticketId} className="border-b border-line/50 hover:bg-card/50">
                      <td className="py-2 pr-4">
                        <Link
                          href={`/control-plane/tickets/${t.ticketId}`}
                          className="font-medium hover:text-coral-deep"
                        >
                          {t.title}
                        </Link>
                      </td>
                      <td className="py-2 pr-4 text-right font-mono text-xs">{t.calls}</td>
                      <td className="py-2 pr-4 text-right font-mono text-xs">{t.toolCalls}</td>
                      <td className="py-2 pr-4 text-right font-mono text-xs">
                        {t.tokens.toLocaleString('hu-HU')}
                      </td>
                      <td className="py-2 pr-4 text-right font-mono text-xs">{t.avgLatencyMs} ms</td>
                      <td className="py-2 text-right font-mono text-xs">€{t.cost.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.perTicket.length === 0 && (
                <p className="py-8 text-center text-ink-faint">
                  Ebben az időszakban még nincs ticketenkénti forgalom
                </p>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
