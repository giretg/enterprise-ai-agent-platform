'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import { getChannelOpsMetrics, runChannelRetentionPurge } from '@/app/actions/channel-ops'

type MetricsResult = Awaited<ReturnType<typeof getChannelOpsMetrics>>
export type ChannelOpsMetricsView = Extract<MetricsResult, { success: true }>['data']

/** Kiemelt hiba-küszöb: nem nulla hiba → figyelemfelhívó szín (nem riasztás, csak jelzés). */
function StatBox({
  label,
  value,
  hint,
  alert,
}: {
  label: string
  value: string | number
  hint?: string
  alert?: boolean
}) {
  return (
    <div
      className={`rounded-lg border p-3 text-center ${
        alert ? 'border-coral/40 bg-coral/10' : 'border-line/60 bg-panel/40'
      }`}
    >
      <p className="text-xs text-ink-faint">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${alert ? 'text-coral-deep' : 'text-ink'}`}>{value}</p>
      {hint ? <p className="mt-1 text-[11px] leading-tight text-ink-faint">{hint}</p> : null}
    </div>
  )
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('hu-HU')
}

const WINDOW_OPTIONS: { label: string; days: number }[] = [
  { label: 'Utolsó 24 óra', days: 1 },
  { label: 'Utolsó 7 nap', days: 7 },
  { label: 'Utolsó 30 nap', days: 30 },
  { label: 'Teljes előzmény', days: 0 },
]

export function ChannelOpsPanel({
  initial,
  canEdit,
}: {
  initial: ChannelOpsMetricsView
  canEdit: boolean
}) {
  const [metrics, setMetrics] = useState(initial)
  const [windowDays, setWindowDays] = useState(7)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function refresh(days: number) {
    setWindowDays(days)
    setMessage(null)
    startTransition(async () => {
      const res = await getChannelOpsMetrics({ windowDays: days })
      if (res.success) setMetrics(res.data)
      else setMessage({ tone: 'err', text: res.error })
    })
  }

  function purge() {
    setMessage(null)
    startTransition(async () => {
      const res = await runChannelRetentionPurge({})
      if (!res.success) {
        setMessage({ tone: 'err', text: res.error })
        return
      }
      const r = res.data
      setMessage({
        tone: 'ok',
        text: `Takarítás kész: ${r.deleted} törölve, ${r.alreadyGone} már nem létezett, ${r.failed} később újrapróbálandó (${r.scanned} átnézve).`,
      })
      // Frissítjük a metrikát, hogy a takarítási lemaradás azonnal látszódjon.
      const fresh = await getChannelOpsMetrics({ windowDays })
      if (fresh.success) setMetrics(fresh.data)
    })
  }

  const { traffic, errors, health, bot } = metrics
  const hasErrors =
    errors.turnsFailed > 0 ||
    errors.linksRejected > 0 ||
    errors.outboundBlocked > 0 ||
    errors.identitiesBlocked > 0

  return (
    <Card title="Csatorna — forgalom és hibák (Telegram üzemeltetés)">
      <div className="space-y-6">
        <p className="text-xs text-ink-soft">
          Itt látod, „forog-e” a Telegram-csatorna és „elromlott-e valami”. A számok a
          módosíthatatlan audit-láncból és a csatorna-táblák állapotából jönnek — a külső
          Telegram-azonosítók <strong>álnevesítve</strong> szerepelnek, nyers azonosító sehol.
        </p>

        {/* Bot állapota */}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span
            className={`inline-flex h-2.5 w-2.5 rounded-full ${
              bot.registered && bot.status === 'active' ? 'bg-emerald-400' : 'bg-red-400'
            }`}
          />
          <span className="text-ink">
            {!bot.registered
              ? 'Nincs regisztrált platform-bot — a csatorna nem üzemel.'
              : bot.status === 'active'
                ? 'A platform-bot aktív.'
                : 'A platform-bot kikapcsolva (incidens-elzárás).'}
          </span>
          {bot.registered && !bot.hasWebhookSecret ? (
            <span className="text-coral-deep">Figyelem: nincs beállítva webhook titkos fejléc.</span>
          ) : null}
        </div>

        {/* Időablak-váltó */}
        <div className="flex flex-wrap items-center gap-2">
          {WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              type="button"
              disabled={pending}
              onClick={() => refresh(opt.days)}
              className={`rounded-md border px-3 py-1 text-xs transition ${
                windowDays === opt.days
                  ? 'border-coral/50 bg-coral/10 text-coral-deep'
                  : 'border-line/60 bg-panel/40 text-ink-soft hover:border-line'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Forgalom */}
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">Forgalom</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatBox label="Kiadott összekötő linkek" value={traffic.tokensIssued} />
            <StatBox label="Sikeres összekötések" value={traffic.linksEstablished} />
            <StatBox label="Kimenő üzenetek" value={traffic.outboundSent} />
            <StatBox label="Semleges válaszok (bekötetlen)" value={traffic.unlinkedNotices} />
            <StatBox label="Visszavont kötések" value={traffic.revocations} />
            <StatBox label="Takarított üzenetek" value={traffic.messagesPurged} />
          </div>
        </div>

        {/* Hibák */}
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
            Hibák és figyelendők
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatBox
              label="Elakadt fordulók"
              value={errors.turnsFailed}
              alert={errors.turnsFailed > 0}
              hint="Feldolgozásban elbukott, újrapróbálható"
            />
            <StatBox
              label="Elutasított összekötések"
              value={errors.linksRejected}
              alert={errors.linksRejected > 0}
              hint="Lejárt / elhasznált / hibás link"
            />
            <StatBox
              label="Blokkolt kimenő üzenetek"
              value={errors.outboundBlocked}
              alert={errors.outboundBlocked > 0}
              hint="Érzékenységi kapu — nyers szöveg nem ment ki"
            />
            <StatBox
              label="Letiltott botú kötések"
              value={errors.identitiesBlocked}
              alert={errors.identitiesBlocked > 0}
              hint="A felhasználó letiltotta a botot"
            />
          </div>
        </div>

        {/* Állapot (pillanatnyi) */}
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
            Pillanatnyi állapot
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatBox
              label="Aktív kötések"
              value={health.identities.active}
              hint={`${health.identities.revoked} visszavont · ${health.identities.blocked} letiltott`}
            />
            <StatBox
              label="Munkamenetek"
              value={health.sessions.total}
              hint={`${health.sessions.linked} bekötött`}
            />
            <StatBox
              label="Sorban álló fordulók"
              value={health.turns.queued + health.turns.running}
              hint={`${health.turns.queued} várakozik · ${health.turns.running} fut`}
            />
            <StatBox
              label="Takarításra vár"
              value={health.retention.pendingOutbound}
              alert={health.retention.pendingOutbound > 0}
              hint={`Legrégebbi: ${formatWhen(health.retention.oldestPendingSentAt)}`}
            />
          </div>
        </div>

        {!hasErrors ? (
          <p className="text-xs text-emerald-600">Nincs figyelendő hiba az adott időablakban.</p>
        ) : null}

        {/* Megőrzési takarítás */}
        <div className="rounded-lg border border-line/60 bg-panel/30 p-4">
          <p className="text-sm font-medium text-ink">Megőrzési takarítás</p>
          <p className="mt-1 text-xs text-ink-soft">
            A bot a megőrzési horizonton túl törli a <strong>saját</strong> kimenő üzeneteit a
            Telegram oldalán (a hiteles példány nálunk marad). Privát chatben a bot csak a saját
            üzeneteit tudja törölni — a felhasználó üzeneteit nem. Éles üzemben ez ütemezetten fut;
            innen kézzel is elindítható.
          </p>
          {canEdit ? (
            <button
              type="button"
              disabled={pending}
              onClick={purge}
              className="mt-3 rounded-md border border-coral/50 bg-coral/10 px-4 py-1.5 text-sm text-coral-deep transition hover:bg-coral/20 disabled:opacity-50"
            >
              {pending ? 'Takarítás folyamatban…' : 'Takarítás futtatása most'}
            </button>
          ) : (
            <p className="mt-3 text-xs text-ink-faint">
              A takarítás kézi indításához platform-admin jogosultság kell.
            </p>
          )}
        </div>

        {message ? (
          <p className={`text-xs ${message.tone === 'ok' ? 'text-emerald-600' : 'text-coral-deep'}`}>
            {message.text}
          </p>
        ) : null}

        <p className="text-[11px] text-ink-faint">
          Generálva: {formatWhen(metrics.generatedAt)} ·{' '}
          {metrics.windowSince ? `ablak kezdete: ${formatWhen(metrics.windowSince)}` : 'teljes előzmény'}
        </p>
      </div>
    </Card>
  )
}
