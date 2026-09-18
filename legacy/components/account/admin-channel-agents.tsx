'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import {
  grantChannelAgent,
  revokeChannelAgent,
  setTenantChannelKillSwitch,
  type TenantChannelAgentsView,
} from '@/app/actions/channel-agents'

/**
 * Tenant-admin felület: szervezeti Telegram-kapcsoló + agentenkénti engedélyezés (Telegram
 * feature-spec #70/#75, D5/D13/D54). A magyarázó doboz kimondja a D13/1 figyelmeztetést (az
 * agent telefonról írhat is), és a szekció explicit üres-állapotot kap (D16 / NFR-1).
 */
export function AdminChannelAgents({ initialView }: { initialView: TenantChannelAgentsView }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  // Tagonkénti „melyik agentet adom hozzá" választás.
  const [picks, setPicks] = useState<Record<string, string>>({})

  const { killSwitch, identities, grantableAgents } = initialView
  const hasAnyGrant = identities.some((i) => i.agents.length > 0)

  function run(action: () => Promise<{ success: boolean; error?: string }>, okText: string) {
    startTransition(async () => {
      setMessage(null)
      const res = await action()
      if (res.success) {
        setMessage({ ok: true, text: okText })
        router.refresh()
      } else {
        setMessage({ ok: false, text: res.error ?? 'A művelet nem sikerült.' })
      }
    })
  }

  return (
    <div className="space-y-6">
      <Card title="Telegram-csatorna a szervezetben">
        <div className="space-y-4">
          <p className="text-sm text-ink-soft">
            Ezzel a kapcsolóval azonnal elzárhatod a Telegram-csatornát az egész szervezet
            számára. Kikapcsolva a rendszer egyetlen üzenetre sem válaszol Telegramon, és kifelé
            sem küld semmit — a bejövő és kimenő út is zárva marad, amíg vissza nem kapcsolod.
          </p>
          <div
            className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 ${
              killSwitch ? 'border-coral/40 bg-coral/10' : 'border-sage/35 bg-sage/10'
            }`}
          >
            <div className="text-sm">
              <p className="font-medium text-ink">
                {killSwitch ? 'A Telegram-csatorna KI van kapcsolva' : 'A Telegram-csatorna be van kapcsolva'}
              </p>
              <p className="text-ink-soft">
                {killSwitch
                  ? 'A tagok össze tudnak kötni, de senki nem ér el agentet Telegramon.'
                  : 'A tagok elérik a nekik engedélyezett agenteket Telegramon.'}
              </p>
            </div>
            <button
              type="button"
              disabled={pending}
              className={`rounded-full px-4 py-2 text-xs font-semibold disabled:opacity-50 ${
                killSwitch
                  ? 'bg-coral text-card'
                  : 'border border-coral/50 text-coral-deep'
              }`}
              onClick={() =>
                run(
                  () => setTenantChannelKillSwitch({ killSwitch: !killSwitch }),
                  killSwitch
                    ? 'A Telegram-csatornát bekapcsoltuk a szervezetnek.'
                    : 'A Telegram-csatornát kikapcsoltuk — a hozzáférés azonnal lezárult.',
                )
              }
            >
              {killSwitch ? 'Csatorna bekapcsolása' : 'Csatorna kikapcsolása'}
            </button>
          </div>
        </div>
      </Card>

      <Card title="Agentek engedélyezése Telegramra">
        <div className="space-y-4">
          <div className="rounded-lg border border-amber/40 bg-amber/10 p-4 text-sm">
            <p className="font-semibold text-ink">Mielőtt engedélyezel egy agentet, tudnod kell:</p>
            <p className="mt-1 text-ink-soft">
              Az agent Telegramon ugyanazokat a műveleteket végezheti, mint a webes felületen —
              <strong className="text-ink"> beleértve az írásokat is</strong> (pl. adatmódosítás,
              üzenetküldés). A jóváhagyás-köteles lépések továbbra is jóváhagyást kérnek. Csak
              olyan agentet tegyél elérhetővé, aminél ezt tudatosan vállalod.
            </p>
          </div>

          {identities.length === 0 ? (
            <p className="text-sm text-ink-soft">
              Ebben a szervezetben még senki nem kötötte össze a Telegram-fiókját. Amint valaki
              összeköti, itt tudod neki agentenként engedélyezni a Telegram-elérést.
            </p>
          ) : (
            <>
              {!hasAnyGrant && (
                <p className="rounded-lg border border-line bg-night-2 p-3 text-sm text-ink-soft">
                  Nincs Telegramra engedélyezett agent — ilyenkor a felhasználó össze tud kötni,
                  de nem ér el semmit. Adj hozzá alább legalább egy agentet valamelyik taghoz.
                </p>
              )}
              <ul className="space-y-3">
                {identities.map((idn) => {
                  const grantedIds = new Set(idn.agents.map((a) => a.agentId))
                  const addable = grantableAgents.filter((a) => !grantedIds.has(a.id))
                  const pick = picks[idn.identityId] ?? ''
                  return (
                    <li
                      key={idn.identityId}
                      className="rounded-lg border border-line bg-night-2 p-3"
                    >
                      <p className="text-sm font-medium text-ink">{idn.userName}</p>
                      <p className="text-xs text-ink-soft">{idn.userEmail}</p>

                      {idn.agents.length === 0 ? (
                        <p className="mt-2 text-sm text-ink-soft">
                          Ennek a tagnak még nincs Telegramra engedélyezett agentje.
                        </p>
                      ) : (
                        <ul className="mt-2 flex flex-wrap gap-2">
                          {idn.agents.map((a) => (
                            <li
                              key={a.agentId}
                              className="flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1 text-xs text-ink"
                            >
                              <span>{a.agentName}</span>
                              {a.availability === 'agent_removed' && (
                                <span className="text-coral-deep">· a platformon már nem elérhető</span>
                              )}
                              <button
                                type="button"
                                disabled={pending}
                                className="font-semibold text-coral-deep disabled:opacity-50"
                                aria-label={`${a.agentName} engedélyének visszavonása`}
                                onClick={() =>
                                  run(
                                    () =>
                                      revokeChannelAgent({
                                        identityId: idn.identityId,
                                        agentId: a.agentId,
                                      }),
                                    `${a.agentName} Telegram-engedélyét visszavontuk.`,
                                  )
                                }
                              >
                                ×
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}

                      {addable.length > 0 && (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <select
                            value={pick}
                            disabled={pending}
                            className="rounded-lg border border-line bg-card px-3 py-1.5 text-sm text-ink"
                            onChange={(e) =>
                              setPicks((p) => ({ ...p, [idn.identityId]: e.target.value }))
                            }
                          >
                            <option value="">Válassz agentet…</option>
                            {addable.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            disabled={pending || !pick}
                            className="rounded-full bg-coral px-4 py-1.5 text-xs font-semibold text-card disabled:opacity-50"
                            onClick={() => {
                              const agentId = pick
                              if (!agentId) return
                              const name = addable.find((a) => a.id === agentId)?.name ?? 'Az agent'
                              setPicks((p) => ({ ...p, [idn.identityId]: '' }))
                              run(
                                () => grantChannelAgent({ identityId: idn.identityId, agentId }),
                                `${name} mostantól elérhető ennek a tagnak Telegramon.`,
                              )
                            }}
                          >
                            Engedélyezés
                          </button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </>
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
      </Card>
    </div>
  )
}
