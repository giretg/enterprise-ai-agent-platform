import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTicket } from '@/app/actions/platform'
import { ProposalCard } from '@/components/tickets/proposal-card'
import { Badge } from '@/components/ui/shell'
import { TICKET_STATE_LABELS, TICKET_STATE_TONE } from '@/lib/ticket-labels'

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ proposalId: string }>
}) {
  const { proposalId } = await params
  const res = await getTicket({ id: proposalId })
  if (!res.success) notFound()

  const ticket = res.data
  const payload = ticket.payload as Record<string, unknown>
  const proposal = payload.proposal as Record<string, unknown> | undefined

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-2xl font-semibold">Javaslat részlet</h1>
        <Badge tone={TICKET_STATE_TONE[ticket.state] ?? 'neutral'}>
          {TICKET_STATE_LABELS[ticket.state] ?? ticket.state}
        </Badge>
      </div>

      {proposal ? (
        <ProposalCard proposal={proposal} title="Kinyert mezők + javaslat" />
      ) : (
        <p className="text-ink-soft">Nincs proposal payload</p>
      )}

      {typeof payload.reasoning === 'string' && (
        <p className="text-sm leading-relaxed text-ink-soft">{payload.reasoning}</p>
      )}

      <Link
        href={`/control-plane/tickets/${ticket.id}`}
        className="inline-block rounded-full bg-coral/20 px-5 py-2.5 text-sm font-semibold text-coral hover:bg-coral/30"
      >
        Küldés jóváhagyásra (Control Plane)
      </Link>
    </div>
  )
}
