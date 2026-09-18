'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import {
  setMyChannelAgentProject,
  type MyChannelAgentsView,
} from '@/app/actions/channel-agents'

/**
 * Felhasználói felület: a saját Telegramra engedélyezett agentek és a projektkulcsuk
 * (Telegram feature-spec #70/#75, D5/D9/D33). A felhasználó itt állítja be, melyik projekthez
 * tartozzon egy agent Telegramon; a platformon elvett vagy nem engedélyezett agent nem
 * választható, de érthető jelzést kap (nem nyers hiba). NFR-1: hétköznapi magyar.
 */
export function MyChannelAgents({
  initialView,
  embedded = false,
}: {
  initialView: MyChannelAgentsView
  /** Kapcsolt-fiók kártyába ágyazva: nincs külön külső Card. */
  embedded?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(initialView.agents.map((a) => [a.agentId, a.projectKey])),
  )

  // Csak akkor mutatjuk a panelt, ha a felhasználónak van aktív Telegram-kötése ebben a
  // szervezetben — különben az összekötő panel a releváns.
  if (!initialView.linked) return null

  const { channelEnabled, identityId, agents } = initialView

  const body = (
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">
          Itt látod, mely agenteket éred el Telegramon, és beállíthatod, melyik projekthez
          tartozzanak. Minden válasz elején ott lesz, melyik agent és melyik projekt válaszol.
        </p>
        <div className="rounded-lg border border-line bg-night-2 p-3 text-sm text-ink-soft">
          <p className="font-medium text-ink">Amit a Telegramban írhatsz:</p>
          <ul className="mt-1 space-y-0.5">
            <li>
              <code className="text-ink">/agentek</code> — kiket érsz el, és épp melyikkel beszélsz
            </li>
            <li>
              <code className="text-ink">/valt</code> — váltás másik agentre (pl.{' '}
              <code className="text-ink">/valt 2</code>)
            </li>
            <li>
              <code className="text-ink">/szervezet</code> — melyik szervezet nevében beszélsz ott
            </li>
            <li>
              <code className="text-ink">/segitseg</code> — rövid súgó a telefonon
            </li>
          </ul>
        </div>

        {!channelEnabled && (
          <div className="rounded-lg border border-amber/40 bg-amber/10 p-3 text-sm text-ink-soft">
            A szervezeted jelenleg kikapcsolta a Telegram-csatornát, ezért most egyetlen agentet
            sem érsz el Telegramon. A beállításaid megmaradnak, amíg a rendszergazda vissza nem
            kapcsolja.
          </div>
        )}

        {agents.length === 0 ? (
          <p className="rounded-lg border border-line bg-night-2 p-3 text-sm text-ink-soft">
            A rendszergazdád még nem engedélyezett neked agentet Telegramra. Össze tudsz kötni, de
            egyelőre nem érsz el semmit — szólj neki, ha szeretnéd használni.
          </p>
        ) : (
          <ul className="space-y-3">
            {agents.map((a) => {
              const draft = drafts[a.agentId] ?? a.projectKey
              const dirty = draft.trim() !== a.projectKey
              const removed = a.availability === 'agent_removed'
              return (
                <li
                  key={a.agentId}
                  className="rounded-lg border border-line bg-night-2 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-ink">{a.agentName}</p>
                    {removed && (
                      <span className="text-xs text-coral-deep">
                        Ez az agent már nem elérhető a platformon — Telegramon sem választható.
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="text-xs text-ink-soft" htmlFor={`project-${a.agentId}`}>
                      Projekt:
                    </label>
                    <input
                      id={`project-${a.agentId}`}
                      value={draft}
                      disabled={pending || removed}
                      className="rounded-lg border border-line bg-card px-3 py-1.5 text-sm text-ink disabled:opacity-50"
                      onChange={(e) =>
                        setDrafts((d) => ({ ...d, [a.agentId]: e.target.value }))
                      }
                    />
                    <button
                      type="button"
                      disabled={pending || removed || !dirty || !draft.trim()}
                      className="rounded-full bg-coral px-4 py-1.5 text-xs font-semibold text-card disabled:opacity-50"
                      onClick={() =>
                        startTransition(async () => {
                          setMessage(null)
                          const res = await setMyChannelAgentProject({
                            identityId,
                            agentId: a.agentId,
                            projectKey: draft.trim(),
                          })
                          if (res.success) {
                            setMessage({ ok: true, text: `${a.agentName} projektjét frissítettük.` })
                            router.refresh()
                          } else {
                            setMessage({ ok: false, text: res.error })
                          }
                        })
                      }
                    >
                      Mentés
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-ink-soft">
                    Az alapértelmezett projekt a gyűjtő (<code>__general__</code>). Egyedi
                    projektkulccsal az agent Telegramon is ugyanabban a projekt-emlékezetben
                    dolgozik, mint a weben.
                  </p>
                </li>
              )
            })}
          </ul>
        )}

        {message && (
          <div
            className={`rounded-lg border p-3 text-sm ${
              message.ok
                ? 'border-sage/35 bg-sage/10 text-sage'
                : 'border-coral/35 bg-coral/10 text-coral-deep'
            }`}
          >
            {message.text}
          </div>
        )}
      </div>
  )

  if (embedded) {
    return (
      <div className="space-y-3 border-t border-line/60 pt-4">
        <h3 className="font-display text-base font-semibold">Az agentjeid Telegramon</h3>
        {body}
      </div>
    )
  }

  return <Card title="Az agentjeid Telegramon">{body}</Card>
}
