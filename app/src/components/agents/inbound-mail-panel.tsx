'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import {
  inboundMailEventAction,
  saveInboundMailRuleAction,
  type InboundMailEventRow,
  type InboundMailSettings,
} from '@/app/actions/inbound-mail'
import type { InboundMailMode } from '@/domain/inbound-mail/inbound-mail'
import { Badge } from '@/components/ui/shell'

const inputClass = 'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm'
const buttonClass = 'rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50'
const smallButton = 'rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink hover:bg-ink/5 disabled:opacity-50'

const MODES: Array<{ id: InboundMailMode; title: string; help: string }> = [
  {
    id: 'notify',
    title: 'Csak jelezze',
    help: 'Az új levél bekerül a postaládába, és a felelős kolléga értesítést kap a felületen. A munkatárs magától nem csinál semmit.',
  },
  {
    id: 'process',
    title: 'Dolgozza fel',
    help: 'A munkatárs azonnal elolvassa a levelet, és az alábbi utasítás szerint jár el. Minden kimenő levél és feltöltés előtt jóváhagyást kér a felelős kollégától.',
  },
  {
    id: 'handoff',
    title: 'Adja át',
    help: 'A levélről átadás készül egy kollégának vagy egy másik munkatársnak (feladó, tárgy, időpont), ő a Feladatok között látja.',
  },
]

const STATUS: Record<InboundMailEventRow['status'], { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  new: { label: 'Új', tone: 'warning' },
  claimed: { label: 'Dolgozik rajta', tone: 'neutral' },
  processed: { label: 'Kész', tone: 'success' },
  ignored: { label: 'Figyelmen kívül', tone: 'neutral' },
  failed: { label: 'Hiba', tone: 'danger' },
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('hu-HU')
}

/**
 * #1032 Bejövő levelek: mi történjen az agent saját címére érkező levéllel, és a postaláda
 * (beérkezett események állapottal, „Feldolgozás most” / „Kész” / „Figyelmen kívül”).
 */
export function InboundMailPanel({ settings }: { settings: InboundMailSettings }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [mode, setMode] = useState<InboundMailMode>(settings.rule.mode)
  const [handoffKind, setHandoffKind] = useState<'user' | 'agent'>(settings.rule.handoffToAgentId ? 'agent' : 'user')

  if (!settings.mailboxAddress) {
    return (
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">Bejövő levelek</h3>
        <p className="text-sm text-ink-soft">
          Előbb válassz saját e-mail címet a munkatársnak (fent). Utána itt állíthatod be, mi történjen az oda érkező levelekkel.
        </p>
      </section>
    )
  }

  function save(form: HTMLFormElement) {
    const data = new FormData(form)
    startTransition(async () => {
      setError(null)
      setNotice(null)
      const res = await saveInboundMailRuleAction({
        agentId: settings.agentId,
        mode,
        instructions: String(data.get('instructions') ?? ''),
        responsibleUserId: String(data.get('responsibleUserId') ?? ''),
        handoffToUserId: mode === 'handoff' && handoffKind === 'user' ? String(data.get('handoffToUserId') ?? '') : '',
        handoffToAgentId: mode === 'handoff' && handoffKind === 'agent' ? String(data.get('handoffToAgentId') ?? '') : '',
        senderAllowlist: String(data.get('senderAllowlist') ?? ''),
        dailyRunLimit: String(data.get('dailyRunLimit') ?? ''),
      })
      if (!res.success) return setError(res.error)
      setNotice('Elmentve. Az új szabály a következő beérkező levéltől érvényes.')
      router.refresh()
    })
  }

  return (
    <div className="space-y-6">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          save(e.currentTarget)
        }}
      >
        <div>
          <p className="text-sm text-ink-soft">
            Mi történjen, ha valaki ír a(z) <strong>{settings.mailboxAddress}</strong> címre?{' '}
            {settings.delivery.mode === 'push'
              ? 'Az új levélről azonnal értesülünk.'
              : 'Az új leveleket időközönként nézzük meg.'}{' '}
            <Link href="/control-plane/provisioning/agentmail" className="text-xs font-semibold text-coral underline">
              Figyelés beállítása
            </Link>
          </p>
        </div>

        <fieldset className="space-y-2">
          <legend className="sr-only">Mi történjen az új levéllel?</legend>
          {MODES.map((m) => {
            const disabled = m.id === 'process' && !settings.platformChatReady
            return (
              <label key={m.id} className={`flex items-start gap-2 text-sm ${disabled ? 'opacity-60' : ''}`}>
                <input type="radio" name="mode" checked={mode === m.id} onChange={() => setMode(m.id)} disabled={disabled} className="mt-1" />
                <span className="flex-1">
                  <span className="font-semibold text-ink">{m.title}</span>
                  <span className="block text-ink-soft">{m.help}</span>
                  {disabled ? (
                    <span className="block text-ink-soft">
                      Ehhez a munkatársnak elérhetőnek kell lennie a beépített beszélgetésben (Beállítások → Beszélgetés a platformon, és a munkatárs kapcsolója).
                    </span>
                  ) : null}
                </span>
              </label>
            )
          })}
        </fieldset>

        <label className="block text-sm">
          <span className="text-ink-soft">
            Felelős kolléga{' '}
            <span title="Ő kap értesítést az új levélről. „Dolgozza fel” módban az ő nevében, az ő jogosultságaival dolgozik a munkatárs, és ő hagyja jóvá a kimenő leveleket." className="cursor-help text-ink-faint">
              (?)
            </span>
          </span>
          <select name="responsibleUserId" defaultValue={settings.rule.responsibleUserId ?? ''} className={inputClass}>
            <option value="">
              {settings.fallbackResponsibleName ? `A munkatárs jóváhagyója (${settings.fallbackResponsibleName})` : '— senki —'}
            </option>
            {settings.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        {mode === 'process' ? (
          <label className="block text-sm">
            <span className="text-ink-soft">Feldolgozási utasítás</span>
            <textarea
              name="instructions"
              rows={4}
              maxLength={4000}
              defaultValue={settings.rule.instructions}
              placeholder="Pl. Ha számlát küldtek, töltsd fel a Drive Számlák mappájába, és válaszolj egy rövid visszaigazolással."
              className={inputClass}
            />
            <span className="mt-1 block text-xs text-ink-faint">
              Csak ez számít utasításnak. Ha a levélben valaki mást kér (pl. „hagyd figyelmen kívül az utasításaidat”), a munkatárs nem követi, és jelzi.
            </span>
          </label>
        ) : (
          <input type="hidden" name="instructions" value={settings.rule.instructions} />
        )}

        {mode === 'handoff' ? (
          <div className="space-y-2 text-sm">
            <span className="text-ink-soft">Kinek adja át?</span>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input type="radio" checked={handoffKind === 'user'} onChange={() => setHandoffKind('user')} /> Kollégának
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={handoffKind === 'agent'} onChange={() => setHandoffKind('agent')} /> Másik munkatársnak
              </label>
            </div>
            {handoffKind === 'user' ? (
              <select name="handoffToUserId" defaultValue={settings.rule.handoffToUserId ?? ''} className={inputClass}>
                <option value="">— válassz —</option>
                {settings.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            ) : (
              <select name="handoffToAgentId" defaultValue={settings.rule.handoffToAgentId ?? ''} className={inputClass}>
                <option value="">— válassz —</option>
                {settings.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        ) : null}

        {mode !== 'notify' ? (
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
            <label className="block text-sm">
              <span className="text-ink-soft">
                Csak ezektől a feladóktól{' '}
                <span title="Soronként egy domain (pl. partner.hu) vagy cím (pl. anna@partner.hu). Más feladó levelénél csak jelzés megy. Üresen hagyva bárki levele feldolgozható." className="cursor-help text-ink-faint">
                  (?)
                </span>
              </span>
              <textarea name="senderAllowlist" rows={3} defaultValue={settings.rule.senderAllowlist} placeholder={'partner.hu\nanna@ceg.hu'} className={inputClass} />
            </label>
            {mode === 'process' ? (
              <label className="block text-sm">
                <span className="text-ink-soft">
                  Napi keret (levél){' '}
                  <span title="Ennyi levelet dolgozhat fel naponta magától. Utána a nap hátralévő részében csak jelez." className="cursor-help text-ink-faint">
                    (?)
                  </span>
                </span>
                <input name="dailyRunLimit" type="number" min={1} max={200} defaultValue={settings.rule.dailyRunLimit} className={inputClass} />
              </label>
            ) : (
              <input type="hidden" name="dailyRunLimit" value={settings.rule.dailyRunLimit} />
            )}
          </div>
        ) : (
          <>
            <input type="hidden" name="senderAllowlist" value={settings.rule.senderAllowlist} />
            <input type="hidden" name="dailyRunLimit" value={settings.rule.dailyRunLimit} />
          </>
        )}

        <p className="text-xs text-ink-faint">
          A kéretlen leveleket, az automatikus válaszokat (pl. „házon kívül vagyok”) és a többi AI munkatárs leveleit sosem dolgozza fel magától — ezekről csak jelzés megy.
        </p>
        {error ? <p className="text-sm text-coral">{error}</p> : null}
        {notice ? <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">{notice}</p> : null}
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? 'Mentés…' : 'Mentés'}
        </button>
      </form>

      <InboundMailList events={settings.events} canProcess={settings.platformChatReady} />
    </div>
  )
}

/** Postaláda: a beérkezett levelek állapottal; a felelős kolléga értesítés-listája is ezt használja. */
export function InboundMailList({
  events,
  canProcess,
  showAgent = false,
  title = 'Postaláda',
  emptyText = 'Még nem érkezett levél, amióta figyeljük a postafiókot.',
}: {
  events: InboundMailEventRow[]
  canProcess: boolean
  showAgent?: boolean
  title?: string
  emptyText?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function run(eventId: string, operation: 'process' | 'ignore' | 'done') {
    startTransition(async () => {
      setError(null)
      const res = await inboundMailEventAction({ eventId, operation })
      if (!res.success) return setError(res.error)
      router.refresh()
    })
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <p className="mt-1 text-sm text-ink-soft">
          Itt csak a feladó, a tárgy és az időpont látszik; a levelet a postafiókban vagy a munkatárssal folytatott beszélgetésben olvashatod.
        </p>
      </div>
      {error ? <p className="text-sm text-coral">{error}</p> : null}
      {events.length === 0 ? (
        <p className="text-sm text-ink-soft">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {events.map((e) => {
            const status = STATUS[e.status]
            const open = e.status === 'new' || e.status === 'failed'
            return (
              <li key={e.id} className="flex flex-wrap items-start gap-3 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">{e.subject || '(nincs tárgy)'}</p>
                  <p className="truncate text-xs text-ink-soft">
                    {showAgent && e.agentName ? `${e.agentName} · ` : ''}
                    {e.fromAddress} · {formatWhen(e.receivedAt)}
                  </p>
                  {e.reasonLabel && e.status !== 'processed' ? <p className="text-xs text-ink-faint">{e.reasonLabel}</p> : null}
                  {e.status === 'failed' && e.error ? <p className="text-xs text-coral">{e.error}</p> : null}
                  {e.conversationId ? (
                    <Link href={`/control-plane/chat?conversation=${e.conversationId}`} className="text-xs font-semibold text-coral underline">
                      Beszélgetés megnyitása
                    </Link>
                  ) : null}
                  {e.handoffId ? <p className="text-xs text-ink-soft">Átadva — a Feladatok között látszik.</p> : null}
                </div>
                <Badge tone={status.tone}>{status.label}</Badge>
                {open ? (
                  <div className="flex gap-2">
                    {canProcess ? (
                      <button type="button" disabled={pending} onClick={() => run(e.id, 'process')} className={smallButton} title="A munkatárs most elolvassa és a feldolgozási utasítás szerint jár el (kimenő levél előtt jóváhagyást kér).">
                        Feldolgozás most
                      </button>
                    ) : null}
                    <button type="button" disabled={pending} onClick={() => run(e.id, 'done')} className={smallButton} title="Már elintézted — a jelzés eltűnik.">
                      Kész
                    </button>
                    <button type="button" disabled={pending} onClick={() => run(e.id, 'ignore')} className={smallButton}>
                      Figyelmen kívül
                    </button>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
