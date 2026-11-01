'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { deletePublicConversationAction } from '@/app/actions/public-assistant'

export type PublicConversationRow = {
  id: string
  visitorId: string
  startedAt: string
  lastActivityAt: string
  handoff: string
  handoffContact: string | null
  handoffSummary: string | null
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
}

const HANDOFF_LABEL: Record<string, string> = {
  forwarded: 'Továbbítva e-mailben',
  callback_requested: 'Visszahívást kér',
}

/** #1016 D17/D18: a nyilvános beszélgetések visszanézése és végleges törlése (auditnaplóval). */
export function PublicConversations({
  agentId,
  rows,
  isAdmin,
  retentionDays,
}: {
  agentId: string
  rows: PublicConversationRow[]
  isAdmin: boolean
  retentionDays: number
}) {
  const router = useRouter()
  const [open, setOpen] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [notice, setNotice] = useState<string | null>(null)

  function remove(input: { sessionId?: string; visitorId?: string }, question: string) {
    if (!confirm(question)) return
    startTransition(async () => {
      const res = await deletePublicConversationAction({ agentId, ...input })
      setNotice(res.success ? `Véglegesen törölve (${res.data.deleted} beszélgetés).` : res.error)
      if (res.success) router.refresh()
    })
  }

  return (
    <section className="atelier-card space-y-3 p-5">
      <h2 className="font-display text-lg font-semibold">Nyilvános beszélgetések</h2>
      <p className="text-xs text-ink-soft">
        A beszélgetéseket {retentionDays} napig őrizzük, utána automatikusan törlődnek. A kipróbálás közben folytatott
        beszélgetések nem jelennek meg itt.
      </p>
      {notice ? <p className="text-sm text-ink">{notice}</p> : null}
      {rows.length === 0 ? (
        <p className="text-sm text-ink-soft">Még nem beszélt senki az asszisztenssel.</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((row) => {
            const first = row.messages.find((m) => m.role === 'user')?.content ?? '(nincs üzenet)'
            return (
              <li key={row.id} className="py-3">
                <button type="button" className="flex w-full items-start justify-between gap-3 text-left" onClick={() => setOpen(open === row.id ? null : row.id)}>
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-ink">{first}</span>
                    <span className="text-xs text-ink-soft">
                      {new Date(row.lastActivityAt).toLocaleString('hu-HU')} · {row.messages.filter((m) => m.role === 'user').length} kérdés
                    </span>
                  </span>
                  {HANDOFF_LABEL[row.handoff] ? (
                    <span className="shrink-0 rounded-full bg-honey/15 px-2.5 py-0.5 text-xs font-semibold text-honey">{HANDOFF_LABEL[row.handoff]}</span>
                  ) : null}
                </button>
                {open === row.id ? (
                  <div className="mt-3 space-y-2">
                    {row.handoffContact ? (
                      <p className="rounded-lg border border-line px-3 py-2 text-sm">
                        <strong>Elérhetőség:</strong> {row.handoffContact}
                        {row.handoffSummary ? (
                          <>
                            <br />
                            <strong>Kérés:</strong> {row.handoffSummary}
                          </>
                        ) : null}
                      </p>
                    ) : null}
                    {row.messages.map((m, i) => (
                      <p key={i} className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${m.role === 'user' ? 'bg-coral/10' : 'bg-night-2'}`}>
                        <span className="text-xs font-semibold text-ink-soft">{m.role === 'user' ? 'Látogató' : 'Asszisztens'}: </span>
                        {m.content}
                      </p>
                    ))}
                    {isAdmin ? (
                      <div className="flex flex-wrap gap-3 pt-1 text-xs">
                        <button type="button" disabled={pending} className="font-semibold text-coral" onClick={() => remove({ sessionId: row.id }, 'Véglegesen törlöd ezt a beszélgetést?')}>
                          Beszélgetés törlése
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          className="font-semibold text-coral"
                          onClick={() => remove({ visitorId: row.visitorId }, 'Véglegesen törlöd ennek a látogatónak az ÖSSZES beszélgetését? (adattörlési kérelem)')}
                        >
                          A látogató összes beszélgetésének törlése
                        </button>
                      </div>
                    ) : null}
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
