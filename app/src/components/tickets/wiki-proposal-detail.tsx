'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { getTicket } from '@/app/actions/platform'
import { SandboxReportPanel } from '@/components/tickets/sandbox-report-panel'
import { ProposalCard } from '@/components/tickets/proposal-card'
import { Badge, Card } from '@/components/ui/shell'
import { TICKET_STATE_LABELS, TICKET_STATE_TONE } from '@/lib/ticket-labels'

type TicketState =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'awaiting_human'
  | 'needs_info'
  | 'approved'
  | 'done'
  | 'rejected'

type SandboxReport = {
  id: string
  name: string
  version: number
  htmlHash: string
  sourceTicketId: string
  createdAt: Date | string
}

type WikiProposalDetailProps = {
  ticketId: string
  initialState: TicketState
  initialPayload: Record<string, unknown>
  initialSandboxReport: SandboxReport | null
}

function readAnswer(payload: Record<string, unknown>) {
  return {
    answer: typeof payload.answer === 'string' ? payload.answer : null,
    rationale: typeof payload.rationale === 'string' ? payload.rationale : null,
    sources: Array.isArray(payload.sources) ? payload.sources : [],
    proposal: payload.proposal as Record<string, unknown> | undefined,
    reasoning: typeof payload.reasoning === 'string' ? payload.reasoning : null,
  }
}

export function WikiProposalDetail({
  ticketId,
  initialState,
  initialPayload,
  initialSandboxReport,
}: WikiProposalDetailProps) {
  const [state, setState] = useState(initialState)
  const [payload, setPayload] = useState(initialPayload)
  const [sandboxReport, setSandboxReport] = useState(initialSandboxReport)
  const [pollError, setPollError] = useState<string | null>(null)

  const { answer, rationale, sources, proposal, reasoning } = readAnswer(payload)
  const isPending = !answer && (state === 'ready' || state === 'in_progress')

  useEffect(() => {
    if (!isPending) return

    let cancelled = false
    const poll = async () => {
      const res = await getTicket({ id: ticketId })
      if (cancelled) return
      if (!res.success) {
        setPollError(res.error)
        return
      }

      const ticket = res.data
      const nextPayload =
        typeof ticket.payload === 'object' && ticket.payload !== null && !Array.isArray(ticket.payload)
          ? (ticket.payload as Record<string, unknown>)
          : {}

      setState(ticket.state as TicketState)
      setPayload(nextPayload)

      const nextAnswer = typeof nextPayload.answer === 'string' ? nextPayload.answer : null
      if (nextAnswer && !sandboxReport) {
        const { getSandboxReportForTicket } = await import('@/app/actions/platform')
        const reportRes = await getSandboxReportForTicket({ ticketId })
        if (!cancelled && reportRes.success) {
          setSandboxReport(reportRes.data)
        }
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [isPending, ticketId, sandboxReport])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-2xl font-semibold">Javaslat részlet</h1>
        <Badge tone={TICKET_STATE_TONE[state] ?? 'neutral'}>
          {TICKET_STATE_LABELS[state] ?? state}
        </Badge>
      </div>

      {isPending && (
        <Card title="Agent fut">
          <p className="text-sm leading-relaxed text-ink-soft">
            A dispatcher elindította a harness futást. A válasz automatikusan megjelenik, amint a Goose
            lefut és a board_write visszaírja az eredményt.
          </p>
          {pollError && <p className="mt-2 text-sm text-coral">{pollError}</p>}
        </Card>
      )}

      {answer ? (
        <Card title="Wiki-válasz">
          <p className="text-base leading-relaxed text-ink">{answer}</p>
          {rationale && <p className="mt-4 text-sm leading-relaxed text-ink-soft">{rationale}</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            {sources.map((source, index) => (
              <Badge key={index} tone="neutral">
                {typeof source === 'object' && source !== null
                  ? `${'docId' in source ? String(source.docId) : 'source'} · ${
                      'sectionRef' in source ? String(source.sectionRef) : index + 1
                    }`
                  : String(source)}
              </Badge>
            ))}
          </div>
        </Card>
      ) : proposal ? (
        <ProposalCard proposal={proposal} title="Kinyert mezők + javaslat" />
      ) : !isPending ? (
        <p className="text-ink-soft">Nincs megjeleníthető válasz payload</p>
      ) : null}

      {reasoning && <p className="text-sm leading-relaxed text-ink-soft">{reasoning}</p>}

      {answer && <SandboxReportPanel ticketId={ticketId} initialReport={sandboxReport} />}

      <Link
        href={`/control-plane/tickets/${ticketId}`}
        className="inline-block rounded-full bg-coral/20 px-5 py-2.5 text-sm font-semibold text-coral hover:bg-coral/30"
      >
        Megnyitás a Control Plane-ben
      </Link>
    </div>
  )
}
