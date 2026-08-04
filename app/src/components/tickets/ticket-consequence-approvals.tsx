'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  approveConsequenceApproval,
  approveTicketConsequenceApprovals,
  rejectConsequenceApproval,
} from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'

export type TicketConsequenceApproval = {
  approvalId: string
  toolName: string
  summary: string
  expiresAt: string
  expired?: boolean
  failedReason?: string
}

/** Ameddig a ticket dolgozhat, a kártyalista magától frissül. */
const LIVE_STATES = new Set(['ready', 'approved', 'in_progress', 'awaiting_human'])
const POLL_MS = 8_000

type Decision = { status: 'approved' | 'rejected'; note?: string }

function errorLabel(error: string): string {
  switch (error) {
    case 'approval_expired':
      return 'A jóváhagyási ablak lejárt — indítsd újra a feladatot.'
    case 'approval_in_flight':
      return 'A művelet épp fut — várj egy pillanatot.'
    case 'approval_already_decided':
      return 'Ezt a műveletet már eldöntötték.'
    case 'forbidden':
      return 'Nincs jogosultságod a jóváhagyáshoz.'
    case 'ticket_not_found':
    case 'conversation_not_found':
    case 'approval_not_found':
      return 'A jóváhagyás nem található.'
    default:
      return error || 'A jóváhagyás sikertelen'
  }
}

/**
 * Következmény-kapu a ticket felületén — EGY döntés, N művelet.
 *
 * Két, mért UX-hibát zár (`f7ef867f`, 2026-08-04):
 *
 * 1. A lista eddig a lapbetöltés PILLANATKÉPE volt (`useState(initial)`), és a
 *    futás közben született kártyák sosem jelentek meg: a felhasználó 30
 *    műveletből 10-et hagyott jóvá, a többi némán ott maradt. Most a szerverről
 *    érkező `initial` a forrás, a helyi állapot csak a MÁR meghozott döntéseket
 *    tartja — és amíg a ticket dolgozhat, a lista magától újratöltődik.
 * 2. A „mind" gomb 30 kliens-oldali kört futtatott. Most egyetlen szerver-akció
 *    fut le friss listával, tehát tényleg mindet elvégzi.
 */
export function TicketConsequenceApprovals({
  initial,
  ticketId,
  ticketState,
}: {
  initial: TicketConsequenceApproval[]
  ticketId: string
  ticketState: string
}) {
  const router = useRouter()
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchNote, setBatchNote] = useState<string | null>(null)
  const [showDetails, setShowDetails] = useState(false)

  const open = useMemo(
    () => initial.filter((a) => !decisions[a.approvalId] && (!a.expired || a.failedReason)),
    [initial, decisions],
  )
  const anyBusy = busyIds.size > 0 || batchBusy
  // A kártyák futás közben születnek — látszódhatnak, de a CTA csak akkor
  // biztonságos, amikor a runtime már `awaiting_human`-re állt (különben race
  // a loop végével, és a resume sem indul el).
  const canDecide = ticketState === 'awaiting_human'

  // Élő lista: amíg a ticket dolgozhat vagy van nyitott kártya, újratöltjük. A
  // kártyák a futás KÖZBEN születnek — pillanatkép mellett a felhasználó úgy
  // zárná le a feladatot, hogy közben műveletek maradtak jóváhagyatlanul.
  useEffect(() => {
    if (anyBusy) return
    if (!LIVE_STATES.has(ticketState) && open.length === 0) return
    const timer = setInterval(() => router.refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [router, ticketState, open.length, anyBusy])

  const decide = useCallback((approvalId: string, decision: Decision) => {
    setDecisions((prev) => ({ ...prev, [approvalId]: decision }))
  }, [])

  const markBusy = (approvalId: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev)
      if (busy) next.add(approvalId)
      else next.delete(approvalId)
      return next
    })
  }

  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  const approveOne = async (approvalId: string) => {
    if (!canDecide) return
    markBusy(approvalId, true)
    setRowErrors((prev) => ({ ...prev, [approvalId]: '' }))
    try {
      const res = await approveConsequenceApproval({ approvalId })
      if (!res.success) {
        setRowErrors((prev) => ({ ...prev, [approvalId]: errorLabel(res.error) }))
        return
      }
      const resultSummary = (res.data as { resultSummary?: string }).resultSummary
      const warning = (res.data as { warning?: string }).warning
      decide(approvalId, {
        status: 'approved',
        ...(resultSummary ? { note: resultSummary } : warning ? { note: warning } : {}),
      })
      router.refresh()
    } catch (error) {
      setRowErrors((prev) => ({
        ...prev,
        [approvalId]: errorLabel(error instanceof Error ? error.message : ''),
      }))
    } finally {
      markBusy(approvalId, false)
    }
  }

  const rejectOne = async (approvalId: string) => {
    if (!canDecide) return
    markBusy(approvalId, true)
    try {
      const res = await rejectConsequenceApproval({ approvalId })
      if (res.success) {
        decide(approvalId, { status: 'rejected' })
        router.refresh()
      } else {
        setRowErrors((prev) => ({ ...prev, [approvalId]: errorLabel(res.error) }))
      }
    } finally {
      markBusy(approvalId, false)
    }
  }

  const approveAll = async () => {
    if (anyBusy || !canDecide) return
    setBatchBusy(true)
    setBatchNote(null)
    try {
      const res = await approveTicketConsequenceApprovals({ ticketId })
      if (!res.success) {
        setBatchNote(errorLabel(res.error))
        return
      }
      const data = res.data as {
        total: number
        approved: number
        remaining: number
        failed: { summary: string; reason: string }[]
        ticketResumed: boolean
        warning?: string
      }
      const parts = [`${data.approved}/${data.total} művelet lefutott.`]
      if (data.failed.length > 0) {
        parts.push(
          'Nem sikerült: ' +
            data.failed
              .slice(0, 3)
              .map((f) => `${f.summary} (${errorLabel(f.reason)})`)
              .join('; ') +
            (data.failed.length > 3 ? ` — és további ${data.failed.length - 3}.` : ''),
        )
      }
      // A megmaradt tételek nem hiba: a sor időkeretbe ütközött. A felhasználónak
      // tudnia kell, hogy a gomb újbóli megnyomása ONNAN folytatja.
      if (data.remaining > 0) {
        parts.push(
          `Még ${data.remaining} művelet vár — nyomd meg újra a gombot, onnan folytatja.`,
        )
      } else if (data.ticketResumed) {
        parts.push(data.warning ?? 'A feladat magától folytatódik.')
      } else if (data.approved > 0 && data.failed.length === 0) {
        parts.push(
          data.warning ??
            'A műveletek lefutottak — ha a feladat nem indul újra, frissítsd az oldalt.',
        )
      }
      setBatchNote(parts.join(' '))
      router.refresh()
    } catch (error) {
      setBatchNote(errorLabel(error instanceof Error ? error.message : ''))
    } finally {
      setBatchBusy(false)
    }
  }

  const decidedRows = initial.filter((a) => decisions[a.approvalId])
  if (open.length === 0 && decidedRows.length === 0 && !batchNote) return null

  const collecting = open.length > 0 && !canDecide

  return (
    <Card
      title={
        open.length > 0
          ? collecting
            ? `${open.length} művelet gyűlik — jóváhagyás a futás vége után`
            : `${open.length} művelet vár jóváhagyásra`
          : 'Jóváhagyott API-műveletek'
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-faint">
          {collecting
            ? 'Az AI munkatárs még dolgozik; a külső rendszerbe író hívások sorban gyűlnek. A jóváhagyó gomb akkor lesz elérhető, amikor a futás emberi döntésre áll.'
            : 'Ezeket a külső rendszerbe író hívásokat a platform nem futtatta le magától. A gomb megnyomása után sorban lefutnak, és a feladat magától folytatódik.'}
        </p>

        {open.length > 0 && canDecide && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={anyBusy}
              onClick={() => void approveAll()}
              className="rounded-md bg-sky px-3 py-1.5 text-sm font-medium text-night disabled:opacity-50"
            >
              {batchBusy ? 'Jóváhagyás folyamatban…' : `Mind jóváhagyom (${open.length})`}
            </button>
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="text-sm text-ink-faint underline underline-offset-2"
            >
              {showDetails ? 'Részletek elrejtése' : 'Műveletek megtekintése egyenként'}
            </button>
          </div>
        )}

        {open.length > 0 && collecting && (
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="text-sm text-ink-faint underline underline-offset-2"
          >
            {showDetails ? 'Részletek elrejtése' : 'Gyűlő műveletek megtekintése'}
          </button>
        )}

        {batchNote && <p className="text-sm text-ink">{batchNote}</p>}

        {(showDetails || open.length === 0) && (
          <ul className="space-y-2">
            {initial.map((a) => {
              const decision = decisions[a.approvalId]
              const busy = busyIds.has(a.approvalId)
              const openRow = !decision && (!a.expired || Boolean(a.failedReason))
              const note = decision?.note ?? rowErrors[a.approvalId] ?? (a.failedReason ? errorLabel(a.failedReason) : '')
              return (
                <li
                  key={a.approvalId}
                  className="rounded-lg border border-line bg-night-2/40 px-3 py-2 text-sm"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        decision?.status === 'approved'
                          ? 'success'
                          : decision?.status === 'rejected'
                            ? 'neutral'
                            : a.expired && !a.failedReason
                              ? 'neutral'
                              : 'warning'
                      }
                    >
                      {decision?.status === 'approved'
                        ? 'Jóváhagyva'
                        : decision?.status === 'rejected'
                          ? 'Elutasítva'
                          : a.expired && !a.failedReason
                            ? 'Lejárt'
                            : collecting
                              ? 'Gyűlik'
                              : 'Várakozik'}
                    </Badge>
                    <span className="font-medium text-ink">{a.toolName}</span>
                  </div>
                  <p className="text-ink-faint">{a.summary}</p>
                  {note && <p className="mt-1 text-xs text-ink-faint">{note}</p>}
                  {openRow && canDecide && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy || batchBusy}
                        onClick={() => void approveOne(a.approvalId)}
                        className="rounded-md bg-sky px-2.5 py-1 text-xs font-medium text-night disabled:opacity-50"
                      >
                        {busy ? 'Jóváhagyás…' : 'Jóváhagyom'}
                      </button>
                      <button
                        type="button"
                        disabled={busy || batchBusy}
                        onClick={() => void rejectOne(a.approvalId)}
                        className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-faint disabled:opacity-50"
                      >
                        Elutasítom
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Card>
  )
}
