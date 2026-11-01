'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { saveInboundPollMinutesAction, type InboundWatchOverview } from '@/app/actions/inbound-mail'
import { INBOUND_POLL_OPTIONS, inboundPollLabel, type InboundPollMinutes } from '@/lib/inbound-mail-settings'
import { Badge } from '@/components/ui/shell'

function formatWhen(iso: string | null): string {
  if (!iso) return 'még nem'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('hu-HU')
}

/**
 * #1032 „Új levelek figyelése”: postafiókonként, hogy azonnal értesülünk-e az új levélről, és a cég
 * beállítása, milyen gyakran nézzük meg azokat, amelyeknél nincs azonnali értesítés.
 */
export function InboundWatchPanel({ overview }: { overview: InboundWatchOverview }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [minutes, setMinutes] = useState<InboundPollMinutes>(overview.pollMinutes)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const allPush = overview.mailboxes.length > 0 && overview.mailboxes.every((m) => m.delivery === 'push')

  function save(next: InboundPollMinutes) {
    setMinutes(next)
    startTransition(async () => {
      setMessage(null)
      const res = await saveInboundPollMinutesAction({ pollMinutes: next })
      setMessage(res.success ? { ok: true, text: 'Elmentve.' } : { ok: false, text: res.error })
      if (res.success) router.refresh()
    })
  }

  return (
    <section className="space-y-4 rounded-2xl border border-line bg-card p-5">
      <div>
        <h2 className="font-display text-lg font-semibold">Új levelek figyelése</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Ha egy munkatárs saját címére levél érkezik, a platform jelez, vagy a munkatárs magától feldolgozza (ezt a
          munkatárs E-mail beállításainál adod meg). Itt látod, melyik postafiókról értesülünk azonnal.
        </p>
      </div>

      {overview.mailboxes.length === 0 ? (
        <p className="text-sm text-ink-soft">
          Még egyik munkatársnak sincs saját e-mail címe. A munkatárs oldalán, az E-mail résznél adhatsz neki.
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {overview.mailboxes.map((m) => (
            <li key={m.connectorId} className="flex flex-wrap items-start gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-ink">
                  {m.address ?? '(cím nélkül)'} <span className="font-normal text-ink-soft">· {m.kindLabel}</span>
                </p>
                <p className="text-xs text-ink-soft">
                  <Link href={`/control-plane/agents/${m.agentId}?section=email`} className="underline decoration-line underline-offset-2 hover:text-ink">
                    {m.agentName}
                  </Link>{' '}
                  · utoljára: {formatWhen(m.lastCheckedAt)}
                </p>
                {m.note ? <p className="text-xs text-ink-faint">{m.note}</p> : null}
              </div>
              {m.delivery === 'broken' ? (
                <Badge tone="danger" title="A postafiók újbóli bekötéséig nem látjuk az új leveleket.">Nem figyeljük</Badge>
              ) : m.delivery === 'push' ? (
                <Badge tone="success" title="A postafiók szolgáltatója azonnal szól az új levélről.">Azonnal értesül</Badge>
              ) : (
                <Badge tone="warning" title="Nincs azonnali értesítés — a beállított gyakorisággal nézzük meg.">{inboundPollLabel(minutes)}</Badge>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2 border-t border-line pt-4">
        <label className="block text-sm">
          <span className="font-semibold text-ink">Ellenőrzés gyakorisága azonnali értesítés nélkül</span>
          <select
            value={minutes}
            disabled={pending}
            onChange={(e) => save(Number(e.target.value) as InboundPollMinutes)}
            className="mt-1 block w-full max-w-xs rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          >
            {INBOUND_POLL_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {inboundPollLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-ink-soft">
          Csak akkor nézzük meg a postafiókokat, amikor valaki használja a platformot — így éjjel és hétvégén nem
          fut fölöslegesen, és nem nő a költség. Az éjjel érkezett levélről legkésőbb az első belépéskor (vagy a
          napi ellenőrzéskor) értesülsz. A ritkább ellenőrzés kevesebb terhelést jelent, de később veszed észre az új
          levelet.
          {allPush ? ' Most minden postafiók azonnal értesül, ezért ennek nincs hatása.' : ''}
        </p>
        {message ? <p className={`text-xs ${message.ok ? 'text-sage' : 'text-coral'}`}>{message.text}</p> : null}
      </div>
    </section>
  )
}
