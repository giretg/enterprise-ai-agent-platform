'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { resumeTicketAfterConnectorGrant } from '@/app/actions/platform'
import {
  ConnectorGrantNeededPanel,
  type ConnectorGrantNeededView,
} from '@/components/connectors/connector-grant-needed-panel'
import { useVisibilityGatedInterval } from '@/components/tickets/use-visibility-gated-interval'
import { Card } from '@/components/ui/shell'

const LIVE_STATES = new Set(['ready', 'approved', 'in_progress', 'awaiting_human'])
const POLL_MS = 8_000

function stripGrantedQuery() {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (!url.searchParams.has('granted')) return
  url.searchParams.delete('granted')
  const search = url.searchParams.toString()
  window.history.replaceState({}, '', `${url.pathname}${search ? `?${search}` : ''}${url.hash}`)
}

/**
 * Gmail/delegált OAuth-grant kártya a ticketen — gomb + OAuth utáni folytatás.
 *
 * A consequence-kapu mintája: a kártyák futás közben születnek, ezért élő
 * ticketnél a lista magától frissül. `granted=1` (OAuth return) után a
 * szerver ellenőrzi a grantet, és újraindítja a ticketet.
 */
export function TicketConnectorGrants({
  initial,
  ticketId,
  ticketState,
  resumeAfterGrant = false,
}: {
  initial: ConnectorGrantNeededView[]
  ticketId: string
  ticketState: string
  resumeAfterGrant?: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const resumeStartedRef = useRef(false)

  const shouldPoll = !busy && (LIVE_STATES.has(ticketState) || initial.length > 0)
  useVisibilityGatedInterval(() => router.refresh(), POLL_MS, shouldPoll)

  useEffect(() => {
    if (!resumeAfterGrant || resumeStartedRef.current) return
    resumeStartedRef.current = true
    void (async () => {
      setBusy(true)
      setError(null)
      try {
        const res = await resumeTicketAfterConnectorGrant({ ticketId })
        if (!res.success) {
          setError(res.error)
          return
        }
        const warning =
          res.data && typeof res.data === 'object' && 'warning' in res.data
            ? String((res.data as { warning?: string }).warning ?? '')
            : ''
        setStatus(
          warning
            ? `Hozzáférés megadva — a folytatás figyelmeztetéssel indult: ${warning}`
            : 'Hozzáférés megadva — a feladat folytatódik.',
        )
        stripGrantedQuery()
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'A folytatás sikertelen.')
      } finally {
        setBusy(false)
      }
    })()
  }, [resumeAfterGrant, router, ticketId])

  if (initial.length === 0 && !status && !error) return null

  return (
    <Card>
      {error && <p className="mb-3 text-sm text-coral">{error}</p>}
      {status && <p className="mb-3 text-sm text-ink-soft">{status}</p>}
      {busy && initial.length === 0 && (
        <p className="text-sm text-ink-faint">Hozzáférés ellenőrzése, a feladat folytatása…</p>
      )}
      {initial.length > 0 && (
        <ConnectorGrantNeededPanel
          cards={initial}
          returnTo={{ kind: 'ticket', id: ticketId }}
          onBusy={setBusy}
        />
      )}
    </Card>
  )
}
